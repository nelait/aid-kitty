import { Router, Request, Response } from 'express';
import { db } from '../db';
import { users, subscriptions } from '../../shared/schema';
import { eq } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import jwt from 'jsonwebtoken';
import { fulfillmentApi } from './fulfillment-api';

const JWT_SECRET = process.env.SESSION_SECRET || 'your-secret-key';

/**
 * SaaS Landing Page Handler
 * 
 * When a customer purchases the SaaS offer on AppSource, Microsoft redirects
 * them to this landing page with a marketplace token. We:
 * 1. Resolve the token to get subscription details
 * 2. Find or create the user
 * 3. Activate the subscription
 * 4. Redirect to the app dashboard
 */
export function createLandingPageRouter(): Router {
  const router = Router();

  // GET /api/marketplace/landing — SaaS landing page
  router.get('/', async (req: Request, res: Response) => {
    try {
      const { token: marketplaceToken } = req.query;

      if (!marketplaceToken) {
        return res.status(400).json({
          error: 'Missing marketplace token',
          message: 'This page should be accessed from Microsoft AppSource after purchasing a subscription.',
        });
      }

      // Step 1: Resolve the marketplace token
      console.log('[Marketplace] Resolving subscription token...');
      const resolved = await fulfillmentApi.resolveSubscription(marketplaceToken as string);
      console.log('[Marketplace] Resolved subscription:', resolved.subscription.id);

      const subscriptionData = resolved.subscription;
      const beneficiary = subscriptionData.beneficiary;

      // Step 2: Find or create the user
      let [existingUser] = await db.select().from(users)
        .where(eq(users.microsoftId, beneficiary.objectId))
        .limit(1);

      if (!existingUser) {
        // Try to find by email
        [existingUser] = await db.select().from(users)
          .where(eq(users.email, beneficiary.emailId))
          .limit(1);

        if (existingUser) {
          // Link Microsoft identity
          await db.update(users).set({
            microsoftId: beneficiary.objectId,
            tenantId: beneficiary.tenantId,
            authProvider: 'microsoft',
            updatedAt: new Date(),
          }).where(eq(users.id, existingUser.id));
        } else {
          // Create new user
          const username = beneficiary.emailId.split('@')[0] + '_' + createId().slice(0, 6);
          [existingUser] = await db.insert(users).values({
            username,
            email: beneficiary.emailId,
            passwordHash: 'marketplace-sso',
            microsoftId: beneficiary.objectId,
            tenantId: beneficiary.tenantId,
            authProvider: 'microsoft',
          }).returning();
        }
      }

      // Step 3: Create or update local subscription record
      const [existingSub] = await db.select().from(subscriptions)
        .where(eq(subscriptions.marketplaceSubscriptionId, subscriptionData.id))
        .limit(1);

      if (existingSub) {
        await db.update(subscriptions).set({
          planId: subscriptionData.planId,
          quantity: subscriptionData.quantity,
          status: 'active',
          saasSubscriptionStatus: subscriptionData.saasSubscriptionStatus,
          updatedAt: new Date(),
        }).where(eq(subscriptions.id, existingSub.id));
      } else {
        await db.insert(subscriptions).values({
          userId: existingUser.id,
          marketplaceSubscriptionId: subscriptionData.id,
          offerId: subscriptionData.offerId,
          planId: subscriptionData.planId,
          status: 'active',
          quantity: subscriptionData.quantity,
          beneficiaryEmail: beneficiary.emailId,
          beneficiaryId: beneficiary.objectId,
          purchaserEmail: subscriptionData.purchaser.emailId,
          purchaserId: subscriptionData.purchaser.objectId,
          saasSubscriptionStatus: subscriptionData.saasSubscriptionStatus,
        });
      }

      // Step 4: Activate the subscription with Microsoft
      try {
        await fulfillmentApi.activateSubscription(
          subscriptionData.id,
          subscriptionData.planId,
          subscriptionData.quantity
        );
        console.log('[Marketplace] Subscription activated:', subscriptionData.id);
      } catch (activateError: any) {
        console.warn('[Marketplace] Activation may have already been done:', activateError.message);
      }

      // Step 5: Issue JWT and redirect to app
      const jwtToken = jwt.sign(
        { id: existingUser.id, username: existingUser.username, email: existingUser.email },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/auth/callback?token=${jwtToken}&redirect=/dashboard&source=marketplace`);

    } catch (error: any) {
      console.error('[Marketplace] Landing page error:', error);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Failed to process marketplace subscription')}`);
    }
  });

  // GET /api/marketplace/landing/health — Health check for the landing page
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'marketplace-landing-page' });
  });

  return router;
}
