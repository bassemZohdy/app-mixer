
// Trusted application code invokes only host-registered capabilities.
export async function invokeCapability(operationId, input) {
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(operationId)) throw Error('Invalid capability ID');
  let response, body;
  try {
    response = await fetch('/api/capabilities/' + operationId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || (response.ok && !Object.hasOwn(body, 'result'))) throw Error('Invalid capability response');
  } catch {
    const error = new Error('Capability outcome uncertain');
    error.code = 'CAPABILITY_OUTCOME_UNCERTAIN';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(body?.error || 'Capability invocation failed');
    error.status = response.status;
    if (response.status >= 500 || body?.code === 'CAPABILITY_OUTCOME_UNCERTAIN') error.code = 'CAPABILITY_OUTCOME_UNCERTAIN';
    throw error;
  }
  return body.result;
}
