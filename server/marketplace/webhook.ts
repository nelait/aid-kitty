import { Router, Request, Response } from 'express';
import { db } from '../db';
import { subscriptions } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { fulfillmentApi } from './fulfillment-api';

/**
 * Microsoft Marketplace Webhook Handler
 * 
 * Microsoft sends webhook notifications for subscription lifecycle events:
 * - ChangePlan: Customer changed their subscription plan
 * - ChangeQuantity: Customer changed seat count
 * - Suspend: Subscription suspended (e.g., non-payment)
 * - Unsubscribe: Customer canceled the subscription
 * - Reinstate: Suspended subscription reinstated
 * 
 * Docs: https://learn.microsoft.com/en-us/partner-center/marketplace/partner-center-portal/pc-saas-fulfillment-webhook
 */

interface WebhookPayload {
  id: string; // Operation ID
  activityId: string;
  subscriptionId: string;
  publisherId: string;
  offerId: string;
  planId: string;
  quantity: number;
  timeStamp: string;
  action: 'ChangePlan' | 'ChangeQuantity' | 'Suspend' | 'Unsubscribe' | 'Reinstate' | 'Renew';
  status: 'InProgress' | 'Success' | 'Failure';
}

export function createWebhookRouter(): Router {
  const router = Router();

  // POST /api/marketplace/webhook — Receive marketplace events
  router.post('/', async (req: Request, res: Response) => {
    try {
      const payload = req.body as WebhookPayload;

      console.log(`[Marketplace Webhook] Action: ${payload.action}, Sub: ${payload.subscriptionId}, Status: ${payload.status}`);

      // Validate the webhook has required fields
      if (!payload.subscriptionId || !payload.action) {
        return res.status(400).json({ error: 'Invalid webhook payload' });
      }

      // Find the local subscription record
      const [subscription] = await db.select().from(subscriptions)
        .where(eq(subscriptions.marketplaceSubscriptionId, payload.subscriptionId))
        .limit(1);

      if (!subscription) {
        console.warn(`[Marketplace Webhook] Unknown subscription: ${payload.subscriptionId}`);
        // Still acknowledge to Microsoft — they may send webhooks for subs we haven't seen yet
        res.status(200).json({ status: 'acknowledged' });
        return;
      }

      // Handle each action type
      switch (payload.action) {
        case 'ChangePlan':
          await db.update(subscriptions).set({
            planId: payload.planId,
            saasSubscriptionStatus: payload.status,
            updatedAt: new Date(),
          }).where(eq(subscriptions.id, subscription.id));

          // Acknowledge the operation
          if (payload.status === 'InProgress') {
            await fulfillmentApi.acknowledgeOperation(
              payload.subscriptionId,
              payload.id,
              payload.planId,
              payload.quantity || subscription.quantity || 1,
              'Success'
            );
          }
          console.log(`[Marketplace Webhook] Plan changed to: ${payload.planId}`);
          break;

        case 'ChangeQuantity':
          await db.update(subscriptions).set({
            quantity: payload.quantity,
            saasSubscriptionStatus: payload.status,
            updatedAt: new Date(),
          }).where(eq(subscriptions.id, subscription.id));

          if (payload.status === 'InProgress') {
            await fulfillmentApi.acknowledgeOperation(
              payload.subscriptionId,
              payload.id,
              payload.planId || subscription.planId,
              payload.quantity,
              'Success'
            );
          }
          console.log(`[Marketplace Webhook] Quantity changed to: ${payload.quantity}`);
          break;

        case 'Suspend':
          await db.update(subscriptions).set({
            status: 'suspended',
            saasSubscriptionStatus: 'Suspended',
            updatedAt: new Date(),
          }).where(eq(subscriptions.id, subscription.id));
          console.log(`[Marketplace Webhook] Subscription suspended: ${payload.subscriptionId}`);
          break;

        case 'Unsubscribe':
          await db.update(subscriptions).set({
            status: 'unsubscribed',
            saasSubscriptionStatus: 'Unsubscribed',
            updatedAt: new Date(),
          }).where(eq(subscriptions.id, subscription.id));
          console.log(`[Marketplace Webhook] Subscription canceled: ${payload.subscriptionId}`);
          break;

        case 'Reinstate':
          await db.update(subscriptions).set({
            status: 'active',
            saasSubscriptionStatus: 'Subscribed',
            updatedAt: new Date(),
          }).where(eq(subscriptions.id, subscription.id));
          console.log(`[Marketplace Webhook] Subscription reinstated: ${payload.subscriptionId}`);
          break;

        case 'Renew':
          console.log(`[Marketplace Webhook] Subscription renewed: ${payload.subscriptionId}`);
          // Renewal is informational — subscription continues as-is
          break;

        default:
          console.warn(`[Marketplace Webhook] Unknown action: ${payload.action}`);
      }

      // Microsoft expects a 200 OK response
      res.status(200).json({ status: 'acknowledged' });

    } catch (error: any) {
      console.error('[Marketplace Webhook] Error:', error);
      // Still return 200 to prevent Microsoft from retrying — we'll handle failures internally
      res.status(200).json({ status: 'error', message: error.message });
    }
  });

  return router;
}
