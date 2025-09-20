import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { db } from './db';
import { users, NewUser } from '../shared/schema';
import { eq } from 'drizzle-orm';

const JWT_SECRET = process.env.SESSION_SECRET || 'your-secret-key';
const SALT_ROUNDS = 12;

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    email: string;
  };
}

export class AuthService {
  async register(username: string, email: string, password: string) {
    // Check if user already exists
    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser.length > 0) {
      throw new Error('User already exists with this email');
    }

    const existingUsername = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existingUsername.length > 0) {
      throw new Error('Username already taken');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const newUser: NewUser = {
      username,
      email,
      passwordHash,
    };

    const [createdUser] = await db.insert(users).values(newUser).returning({
      id: users.id,
      username: users.username,
      email: users.email,
    });

    return createdUser;
  }

  async login(email: string, password: string) {
    // Find user
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        email: user.email 
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    };
  }

  async verifyToken(token: string) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      return decoded;
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  async getUserById(id: string) {
    const [user] = await db.select({
      id: users.id,
      username: users.username,
      email: users.email,
    }).from(users).where(eq(users.id, id)).limit(1);

    return user;
  }
}

// Middleware to authenticate requests
export function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, async (err: any, decoded: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
      const authService = new AuthService();
      const user = await authService.getUserById(decoded.id);
      
      if (!user) {
        return res.status(403).json({ error: 'User not found' });
      }

      req.user = user;
      next();
    } catch (error) {
      return res.status(500).json({ error: 'Authentication error' });
    }
  });
}

// Optional authentication middleware (doesn't fail if no token)
export function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next();
  }

  jwt.verify(token, JWT_SECRET, async (err: any, decoded: any) => {
    if (!err && decoded) {
      try {
        const authService = new AuthService();
        const user = await authService.getUserById(decoded.id);
        if (user) {
          req.user = user;
        }
      } catch (error) {
        // Silently fail for optional auth
      }
    }
    next();
  });
}
