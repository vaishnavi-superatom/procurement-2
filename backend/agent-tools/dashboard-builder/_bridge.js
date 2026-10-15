// Shared by the dashboard builder's tools in this folder — not a tool itself.
//
// Everything specific to the run arrives as environment variables, set by the
// builder's session when it starts; nothing is baked into these files, so one
// copy serves every dashboard's workspace:
//
//   SA_BRIDGE_URL     where the backend's bridge is listening
//   SA_CONTEXT_TOKEN  whose identity this run queries as (row policies apply)
//   SA_DASHBOARD_ID   the dashboard this conversation is about
//   SA_PROGRAM_DIR    absolute path to its program, dashboard-programs/<id>
//
// The agent never passes a dashboard or a program directory itself, so it
// cannot point a tool at a dashboard that is not its own.

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(name + ' is not set — this run has no dashboard-builder session.');
    process.exit(2);
  }
  return value;
}

const BRIDGE = required('SA_BRIDGE_URL');
const CONTEXT_TOKEN = process.env.SA_CONTEXT_TOKEN || '';

/**
 * POST to a bridge route and return the parsed reply. Reports the status and
 * the first of the body worth reading on failure, and exits non-zero — the one
 * contract every tool here relies on.
 */
function post(path, payload) {
  return fetch(BRIDGE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(CONTEXT_TOKEN ? { 'x-sa-context': CONTEXT_TOKEN } : {}),
    },
    body: JSON.stringify(payload),
  }).then(async (r) => {
    const text = await r.text();
    if (!r.ok) { console.error('Request failed (' + r.status + '): ' + text.slice(0, 2000)); process.exit(1); }
    try { return JSON.parse(text); } catch { console.error(text); process.exit(1); }
  }).catch((e) => { console.error('Could not reach the backend: ' + (e && e.message)); process.exit(1); });
}

module.exports = {
  post,
  dashboardId: () => required('SA_DASHBOARD_ID'),
  programDir: () => required('SA_PROGRAM_DIR'),
};
