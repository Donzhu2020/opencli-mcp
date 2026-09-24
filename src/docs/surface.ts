/** Runtime capability catalog shared by browser discovery and model-facing API projection. */
import type { BrowserFeature } from '../protocol.js';

export const BROWSER_CAPABILITIES: Array<{ id: BrowserFeature; description: string; doc?: string }> = [
  { id: 'cdp', description: 'Allowlisted Chrome DevTools Protocol on the current tab.', doc: 'capabilities/cdp' },
  { id: 'viewport', description: 'Temporarily override and reset viewport dimensions.' },
  { id: 'visibility', description: 'Show or hide the session window.', doc: 'capabilities/visibility' },
  { id: 'webmcp', description: 'Tools registered by the current page.', doc: 'capabilities/webmcp' },
];

export const TAB_FEATURES: Record<string, BrowserFeature> = {
  webmcp: 'webmcp', dialog: 'dialogs', console: 'console', network: 'network', frames: 'frames', download: 'downloads',
};

/** Keep generated source documentation complete on disk; project only available members for an MCP client. */
export function projectApiReference(source: string, features: readonly BrowserFeature[]): string {
  const available = new Set(features);
  const lines: string[] = [];
  let inTab = false;
  let skippingObject = false;
  for (const line of source.split('\n')) {
    if (line === 'class Tab {') inTab = true;
    if (inTab && line === '}') inTab = false;
    if (skippingObject) {
      if (line === '  };') skippingObject = false;
      continue;
    }
    if (inTab) {
      const member = /^  (\w+)(?:\(|:)/.exec(line)?.[1];
      const feature = member && TAB_FEATURES[member];
      if (feature && !available.has(feature)) {
        if (line.includes(': {')) skippingObject = true;
        continue;
      }
    }
    lines.push(line);
  }
  const banner = `Available extension features now: ${features.length ? features.join(', ') : 'none (browser disconnected or not advertised)'}. Optional Tab members absent below are unavailable.`;
  return lines.join('\n').replace('```ts\n', `${banner}\n\n\`\`\`ts\n`);
}
