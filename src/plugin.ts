import path from 'path';
import fs from 'fs';
import express, { Express, Router } from 'express';
import { Pool } from 'mysql2/promise';

export interface PluginContext {
  pool: Pool;
  app:  Express;
}

export interface Plugin {
  name:    string;
  version: string;
  // Called once at startup.  Return a Router to mount at /api/plugins/<name>
  init(ctx: PluginContext): Router | void;
}

const PLUGIN_DIR = process.env.PLUGIN_DIR ?? path.join(__dirname, '..', 'plugins');

const loaded: Plugin[] = [];

export function loadPlugins(ctx: PluginContext): void {
  if (!fs.existsSync(PLUGIN_DIR)) return;

  const entries = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.name.endsWith('.js')) continue;
    const pluginPath = entry.isDirectory()
      ? path.join(PLUGIN_DIR, entry.name, 'index.js')
      : path.join(PLUGIN_DIR, entry.name);
    if (!fs.existsSync(pluginPath)) continue;

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(pluginPath) as { default?: Plugin } | Plugin;
      const plugin: Plugin = ('default' in mod && mod.default) ? mod.default : mod as Plugin;

      if (typeof plugin.name !== 'string' || typeof plugin.init !== 'function') {
        console.warn(`[plugins] ${pluginPath}: missing name or init(), skipping`);
        continue;
      }

      const result = plugin.init(ctx);
      if (result) {
        ctx.app.use(`/api/plugins/${plugin.name}`, result);
        console.log(`[plugins] loaded ${plugin.name}@${plugin.version ?? '?'} → /api/plugins/${plugin.name}`);
      } else {
        console.log(`[plugins] loaded ${plugin.name}@${plugin.version ?? '?'}`);
      }
      loaded.push(plugin);
    } catch (err) {
      console.error(`[plugins] failed to load ${pluginPath}:`, err);
    }
  }
}

export function listPlugins(): Array<{ name: string; version: string }> {
  return loaded.map(p => ({ name: p.name, version: p.version ?? '?' }));
}
