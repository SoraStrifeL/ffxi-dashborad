// ════════════════════════════════════════════════════════════════════
//  validate.ts — Zod-backed request validation middleware
//  ────────────────────────────────────────────────────────────────────
//  validateBody / validateParams / validateQuery return an Express
//  middleware that parses the given part of the request against a Zod
//  schema. On failure it responds 400 with a compact list of issues and
//  never calls next(); on success it replaces the request part with the
//  parsed (and coerced) value so handlers get typed, trusted input.
// ════════════════════════════════════════════════════════════════════
import { RequestHandler } from 'express';
import { ZodType, ZodError } from 'zod';

function formatIssues(err: ZodError): string[] {
  return err.issues.map(i => {
    const p = i.path.map(String).join('.');
    return p ? `${p}: ${i.message}` : i.message;
  });
}

function make(part: 'body' | 'params' | 'query'): (schema: ZodType) => RequestHandler {
  return (schema) => (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      res.status(400).json({ error: 'invalid request', details: formatIssues(result.error) });
      return;
    }
    // Express 5 makes req.query a getter-only; assign onto the existing object.
    if (part === 'query') Object.assign(req.query, result.data);
    else (req as unknown as Record<string, unknown>)[part] = result.data;
    next();
  };
}

export const validateBody   = make('body');
export const validateParams = make('params');
export const validateQuery  = make('query');
