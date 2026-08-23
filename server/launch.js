// Role switch so one image can run either the world server or a keeper agent.
// Coolify (Dockerfile build pack) uses the baked CMD, not a custom start command,
// so we branch on an env var instead: UNDERTOW_ROLE=keeper runs the agent.

const role = (process.env.UNDERTOW_ROLE || 'server').toLowerCase();

if (role === 'keeper' || role === 'agent' || role === 'inhabitant') {
  // The inhabitant reads UNDERTOW_URL (and UNDERTOW_TEMPERAMENT) from env.
  process.argv[2] = process.env.UNDERTOW_URL || 'wss://undertow.apps.drwifi.nz/ws';
  await import('../agent/inhabitant.js');
} else {
  await import('./server.js');
}
