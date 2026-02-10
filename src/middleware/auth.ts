/**
 * Auth middleware — pluggable JWT verification
 *
 * tezit-relay does not manage users or passwords.
 * It verifies JWTs issued by whatever auth system you use.
 * The JWT must contain: sub (userId), email (optional), name (optional).
 */

import type { Request, Response, NextFunction } from "express";
import { jwtVerify } from "jose";
import { config } from "../config.js";

export interface AuthUser {
  userId: string;
  email?: string;
  name?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const secret = new TextEncoder().encode(config.jwtSecret);

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, secret);

    if (!payload.sub) {
      res
        .status(401)
        .json({ error: { code: "INVALID_TOKEN", message: "Token must contain sub claim" } });
      return;
    }

    req.user = {
      userId: payload.sub,
      email: payload.email as string | undefined,
      name: payload.name as string | undefined,
    };

    next();
  } catch {
    res
      .status(401)
      .json({ error: { code: "INVALID_TOKEN", message: "Token verification failed" } });
  }
}

/**
 * Require team membership for the given teamId.
 * Must be called after authenticate().
 */
export function requireTeamMember(getTeamId: (req: Request) => string | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const teamId = getTeamId(req);
    if (!teamId) {
      res
        .status(400)
        .json({ error: { code: "MISSING_TEAM", message: "teamId is required" } });
      return;
    }

    // Team membership check is done in the route handlers using the DB
    // This middleware just ensures teamId is present and user is authenticated
    if (!req.user) {
      res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
      return;
    }

    next();
  };
}
