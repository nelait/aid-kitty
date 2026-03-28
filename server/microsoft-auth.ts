import { ConfidentialClientApplication, Configuration, AuthorizationCodeRequest, AuthorizationUrlRequest } from '@azure/msal-node';
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from './db';
import { users } from '../shared/schema';
import { eq, or } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

const JWT_SECRET = process.env.SESSION_SECRET || 'your-secret-key';

// Microsoft Entra ID Configuration
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3002/api/auth/microsoft/callback';

const msalConfig: Configuration = {
  auth: {
    clientId: MICROSOFT_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`,
    clientSecret: MICROSOFT_CLIENT_SECRET,
  },
};

let msalClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
      throw new Error('Microsoft Entra ID credentials not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET environment variables.');
    }
    msalClient = new ConfidentialClientApplication(msalConfig);
  }
  return msalClient;
}

/**
 * Check if Microsoft auth is configured
 */
export function isMicrosoftAuthConfigured(): boolean {
  return !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
}

/**
 * Create or find a user by their Microsoft identity
 */
async function findOrCreateMicrosoftUser(msProfile: {
  oid: string;
  email: string;
  name: string;
  tenantId: string;
}) {
  // First try to find by microsoftId
  const [existingByMsId] = await db.select().from(users)
    .where(eq(users.microsoftId, msProfile.oid))
    .limit(1);

  if (existingByMsId) {
    return existingByMsId;
  }

  // Try to find by email and link the Microsoft account
  const [existingByEmail] = await db.select().from(users)
    .where(eq(users.email, msProfile.email))
    .limit(1);

  if (existingByEmail) {
    // Link Microsoft account to existing user
    const [updated] = await db.update(users)
      .set({
        microsoftId: msProfile.oid,
        tenantId: msProfile.tenantId,
        authProvider: 'microsoft',
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingByEmail.id))
      .returning();
    return updated;
  }

  // Create a new user from Microsoft identity
  const username = msProfile.name.replace(/\s+/g, '').toLowerCase() + '_' + createId().slice(0, 6);
  const [newUser] = await db.insert(users).values({
    username,
    email: msProfile.email,
    passwordHash: 'microsoft-sso', // Placeholder — user authenticates via Microsoft only
    microsoftId: msProfile.oid,
    tenantId: msProfile.tenantId,
    authProvider: 'microsoft',
  }).returning();

  return newUser;
}

/**
 * Issue a JWT for the given user
 */
function issueToken(user: { id: string; username: string; email: string }): string {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Create Microsoft auth routes
 */
export function createMicrosoftAuthRouter(): Router {
  const router = Router();

  // GET /api/auth/microsoft/login — Redirect to Microsoft login page
  router.get('/login', async (req: Request, res: Response) => {
    try {
      const client = getMsalClient();
      const redirectUrl = (req.query.redirect as string) || '/dashboard';

      const authUrlRequest: AuthorizationUrlRequest = {
        scopes: ['user.read', 'email', 'profile', 'openid'],
        redirectUri: MICROSOFT_REDIRECT_URI,
        state: Buffer.from(JSON.stringify({ redirect: redirectUrl })).toString('base64'),
      };

      const authUrl = await client.getAuthCodeUrl(authUrlRequest);
      res.json({ authUrl });
    } catch (error: any) {
      console.error('Microsoft auth URL error:', error);
      res.status(500).json({ error: 'Failed to generate Microsoft login URL', details: error.message });
    }
  });

  // GET /api/auth/microsoft/callback — Handle auth code callback
  router.get('/callback', async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query;

      if (!code) {
        return res.status(400).json({ error: 'Authorization code missing' });
      }

      const client = getMsalClient();

      const tokenRequest: AuthorizationCodeRequest = {
        code: code as string,
        scopes: ['user.read', 'email', 'profile', 'openid'],
        redirectUri: MICROSOFT_REDIRECT_URI,
      };

      const response = await client.acquireTokenByCode(tokenRequest);

      if (!response || !response.account) {
        return res.status(401).json({ error: 'Failed to acquire token' });
      }

      // Extract user info from the token claims
      const claims = response.idTokenClaims as any;
      const email = claims.preferred_username || claims.email || response.account.username;
      const name = claims.name || email.split('@')[0];
      const oid = claims.oid || response.account.localAccountId;
      const tenantId = claims.tid || response.account.tenantId;

      // Find or create user
      const user = await findOrCreateMicrosoftUser({
        oid,
        email,
        name,
        tenantId,
      });

      // Issue JWT
      const token = issueToken({
        id: user.id,
        username: user.username,
        email: user.email,
      });

      // Parse redirect from state
      let redirectUrl = '/dashboard';
      if (state) {
        try {
          const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
          redirectUrl = stateData.redirect || '/dashboard';
        } catch { /* use default */ }
      }

      // Redirect to frontend with token
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/auth/callback?token=${token}&redirect=${encodeURIComponent(redirectUrl)}`);
    } catch (error: any) {
      console.error('Microsoft callback error:', error);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Microsoft sign-in failed')}`);
    }
  });

  // GET /api/auth/microsoft/status — Check if Microsoft auth is configured
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      configured: isMicrosoftAuthConfigured(),
      tenantId: MICROSOFT_TENANT_ID !== 'common' ? MICROSOFT_TENANT_ID : undefined,
    });
  });

  return router;
}
