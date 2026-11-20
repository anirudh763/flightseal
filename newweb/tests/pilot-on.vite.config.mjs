// TEST ONLY (registry-wiring.mjs): the console config with PILOT_AUTHORIZATION_ACCEPTED rewritten to true, built into
// .test-artifacts, never docs/console. The rewrite must match the exact source line, or the build fails.
import base from '../vite.config.js';

const SWITCH = 'export const PILOT_AUTHORIZATION_ACCEPTED = false;';
let matched = false;
export default {
  ...base,
  plugins: [{
    name: 'pilot-switch-on-test-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/recipient-trust.mjs')) return null;
      if (!code.includes(SWITCH)) throw new Error('switch line not found');
      matched = true;
      return code.replace(SWITCH, 'export const PILOT_AUTHORIZATION_ACCEPTED = true;');
    },
    buildEnd() { if (!matched) throw new Error('recipient-trust.mjs was never rewritten'); },
  }, ...base.plugins],
};
