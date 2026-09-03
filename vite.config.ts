import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';

/**
 * Inject the Chrome origin-trial token, when there is one.
 *
 * The token is issued per deployed origin at https://developer.chrome.com/origintrials and
 * lets visitors reach the WebMCP tools without enabling chrome://flags themselves. It is
 * injected rather than written into `index.html` so that a build without a token ships no
 * inert tag at all: an empty or stale token is worse than none, because it looks enabled.
 *
 * The deployed origin must also send the headers in `public/_headers` — WebMCP is only
 * exposed in an origin-isolated document and is gated by the `tools` permissions policy.
 */
function originTrial(token: string | undefined): Plugin {
  return {
    name: 'paleoscope-origin-trial',
    transformIndexHtml: () =>
      token
        ? [{ tag: 'meta', attrs: { 'http-equiv': 'origin-trial', content: token }, injectTo: 'head' }]
        : [],
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [originTrial(loadEnv(mode, process.cwd(), '').VITE_ORIGIN_TRIAL_TOKEN)],
  build: {
    cssMinify: false,
  },
}));
