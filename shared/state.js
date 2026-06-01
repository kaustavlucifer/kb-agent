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

export function updateState(slice, updater) {
  setState(slice, updater(_state[slice]));
}

export function subscribe(slice, fn) {
  if (!_listeners.has(slice)) _listeners.set(slice, new Set());
  _listeners.get(slice).add(fn);
  return () => _listeners.get(slice).delete(fn);
}

export function subscribeMany(slices, fn) {
  const unsubs = slices.map(s => subscribe(s, () => fn(slices.map(getState))));
  return () => unsubs.forEach(u => u());
}

export function reset(slice) {
  delete _state[slice];
  const fns = _listeners.get(slice);
  if (fns) fns.forEach(fn => fn(undefined, slice));
}
