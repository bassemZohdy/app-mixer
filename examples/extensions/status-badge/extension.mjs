// This module is trusted host code. It must never contain credentials.
export function validate(component) {
  if (!component || typeof component.label !== 'string' || component.label.length < 1 || component.label.length > 80 || !['healthy', 'warning'].includes(component.status) || Object.keys(component).some(key => !['id', 'component', 'label', 'status'].includes(key))) {
    throw Error('Invalid status badge');
  }
}
export function render(component, _child, _data, document) {
  const badge = document.createElement('span');
  badge.textContent = `${component.label}: ${component.status}`;
  return badge;
}
// A trusted server host can bind this illustrative tool under its own policy.
export function lookupStatus(input) {
  return {label: input.label, status: 'healthy'};
}
// A generated workspace's extensions.mjs can include this static registration.
export const installedExtension = {
  id: 'sample.status-badge', version: '1.0.0', scope: 'application',
  components: {'status-badge': {render, validate}}
};
