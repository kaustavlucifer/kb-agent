const _state = {};
const _listeners = new Map();

export function getState(slice) {
  return _state[slice];
}

export function setState(slice, value) {
  _state[slice] = value;
  const fns = _listeners.get(slice);
  if (fns) fns.forEach(fn => fn(value, slice));
}

export function subscribe(slice, fn) {
  if (!_listeners.has(slice)) _listeners.set(slice, new Set());
  _listeners.get(slice).add(fn);
  return () => _listeners.get(slice).delete(fn);
}
