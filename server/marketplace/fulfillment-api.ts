import axios, { AxiosInstance } from 'axios';

/**
 * Microsoft SaaS Fulfillment API v2 Client
 * Handles subscription lifecycle management for AppSource SaaS offers.
 * 
 * Docs: https://learn.microsoft.com/en-us/partner-center/marketplace/partner-center-portal/pc-saas-fulfillment-api-v2
 */

const MARKETPLACE_API_BASE = 'https://marketplaceapi.microsoft.com/api/saas';
const API_VERSION = '2018-08-31';

interface MarketplaceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface ResolvedSubscription {
  id: string;
  subscriptionName: string;
  offerId: string;
  planId: string;
  quantity: number;
  subscription: {
    id: string;
    publisherId: string;
    offerId: string;
    name: string;
    saasSubscriptionStatus: string;
    beneficiary: {
      emailId: string;
      objectId: string;
      tenantId: string;
      puid: string;
    };
    purchaser: {
      emailId: string;
      objectId: string;
      tenantId: string;
      puid: string;
    };
    planId: string;
    term: {
      startDate: string;
      endDate: string;
      termUnit: string;
    };
    isTest: boolean;
    isFreeTrial: boolean;
    allowedCustomerOperations: string[];
    sessionId: string;
    fulfillmentId: string;
    storeFront: string;
    quantity: number;
  };
}

export interface SubscriptionDetails {
  id: string;
  publisherId: string;
  offerId: string;
  name: string;
  saasSubscriptionStatus: string;
  beneficiary: {
    emailId: string;
    objectId: string;
    tenantId: string;
  };
  purchaser: {
    emailId: string;
    objectId: string;
    tenantId: string;
  };
  planId: string;
  quantity: number;
  term: {
    startDate: string;
    endDate: string;
    termUnit: string;
  };
  isTest: boolean;
  isFreeTrial: boolean;
  allowedCustomerOperations: string[];
}

export class FulfillmentApiClient {
  private httpClient: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor() {
    this.httpClient = axios.create({
      baseURL: MARKETPLACE_API_BASE,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get an access token for the Marketplace API using client credentials
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Microsoft credentials not configured');
    }

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: '20e940b3-4c77-4b0b-9a53-9e16a1b010a7/.default', // Marketplace API resource
    });

    const response = await axios.post<MarketplaceTokenResponse>(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  /**
   * Set authorization header before each API call
   */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'x-ms-marketplace-token': '',
    };
  }

  /**
   * Resolve a marketplace token to get subscription details
   * Called when a customer lands on the SaaS landing page after purchase
   */
  async resolveSubscription(marketplaceToken: string): Promise<ResolvedSubscription> {
    const token = await this.getAccessToken();

    const response = await this.httpClient.post<ResolvedSubscription>(
      `/subscriptions/resolve?api-version=${API_VERSION}`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-ms-marketplace-token': marketplaceToken,
        },
      }
    );

    return response.data;
  }

  /**
   * Activate a resolved subscription
   * Must be called after resolving and provisioning the customer
   */
  async activateSubscription(subscriptionId: string, planId: string, quantity?: number): Promise<void> {
    const headers = await this.authHeaders();

    await this.httpClient.post(
      `/subscriptions/${subscriptionId}/activate?api-version=${API_VERSION}`,
      { planId, quantity: quantity || 1 },
      { headers }
    );
  }

  /**
   * Get details for a specific subscription
   */
  async getSubscription(subscriptionId: string): Promise<SubscriptionDetails> {
    const headers = await this.authHeaders();

    const response = await this.httpClient.get<SubscriptionDetails>(
      `/subscriptions/${subscriptionId}?api-version=${API_VERSION}`,
      { headers }
    );

    return response.data;
  }

  /**
   * List all subscriptions for this SaaS publisher
   */
  async listSubscriptions(): Promise<SubscriptionDetails[]> {
    const headers = await this.authHeaders();

    const response = await this.httpClient.get<{ subscriptions: SubscriptionDetails[] }>(
      `/subscriptions?api-version=${API_VERSION}`,
      { headers }
    );

    return response.data.subscriptions;
  }

  /**
   * Update a subscription's plan
   */
  async updatePlan(subscriptionId: string, planId: string): Promise<void> {
    const headers = await this.authHeaders();

    await this.httpClient.patch(
      `/subscriptions/${subscriptionId}?api-version=${API_VERSION}`,
      { planId },
      { headers }
    );
  }

  /**
   * Update a subscription's quantity
   */
  async updateQuantity(subscriptionId: string, quantity: number): Promise<void> {
    const headers = await this.authHeaders();

    await this.httpClient.patch(
      `/subscriptions/${subscriptionId}?api-version=${API_VERSION}`,
      { quantity },
      { headers }
    );
  }

  /**
   * Acknowledge a webhook operation
   */
  async acknowledgeOperation(
    subscriptionId: string,
    operationId: string,
    planId: string,
    quantity: number,
    status: 'Success' | 'Failure'
  ): Promise<void> {
    const headers = await this.authHeaders();

    await this.httpClient.patch(
      `/subscriptions/${subscriptionId}/operations/${operationId}?api-version=${API_VERSION}`,
      { planId, quantity, status },
      { headers }
    );
  }
}

// Singleton instance
export const fulfillmentApi = new FulfillmentApiClient();
