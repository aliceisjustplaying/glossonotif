const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('gatewayToken') || '';
if (token) localStorage.setItem('gatewayToken', token);

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const installEl = document.getElementById('install-instructions');
const setupEl = document.getElementById('glosso-setup');
const controlsEl = document.getElementById('controls');
const testButton = document.getElementById('test');
const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
const headers = () => ({ 'content-type': 'application/json', 'x-gateway-token': token });

document.getElementById('subscribe').addEventListener('click', () => run(subscribe));
document.getElementById('unsubscribe').addEventListener('click', () => run(unsubscribe));
testButton.addEventListener('click', () => run(() => post('/api/test')));
document.getElementById('poll').addEventListener('click', () => run(() => post('/api/poll-now')));
document.getElementById('ready').addEventListener('click', () => {
  localStorage.setItem('glossoLoggedIn', 'true');
  updateSetupUi(true);
});

if (standalone) {
  updateServiceWorker();
  refresh();
} else {
  installEl.hidden = false;
  setupEl.hidden = true;
  controlsEl.hidden = true;
  statusEl.textContent = 'install the app to enable push';
  logEl.hidden = true;
}

async function refresh() {
  try {
    const config = await get('/api/config');
    const sub = await currentSubscription();
    updateSetupUi(!!sub);
    statusEl.textContent = sub
      ? `push enabled, ${config.subscriberCount} subscriber(s), polling every ${config.pollSeconds}s`
      : `push not enabled, polling every ${config.pollSeconds}s`;
    write(config);
  } catch (error) {
    statusEl.textContent = error.message === 'unauthorized' ? 'log in to enable push' : error.message;
  }
}

async function subscribe() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('this browser does not support web push');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('notification permission was not granted');

  const config = await get('/api/config');
  const registration = await navigator.serviceWorker.register('/sw.js');
  const existing = await registration.pushManager.getSubscription();
  if (existing) await existing.unsubscribe();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.publicKey),
  });

  await post('/api/subscribe', subscription.toJSON());
  localStorage.removeItem('glossoLoggedIn');
  updateSetupUi(true);
  await refresh();
}

async function unsubscribe() {
  const subscription = await currentSubscription();
  if (subscription) {
    await post('/api/unsubscribe', { endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  await refresh();
}

function updateSetupUi(isSubscribed) {
  if (!standalone) return;
  const needsGlossoLogin = isSubscribed && localStorage.getItem('glossoLoggedIn') !== 'true';
  setupEl.hidden = !needsGlossoLogin;
  testButton.disabled = needsGlossoLogin;
  testButton.title = needsGlossoLogin ? 'Open Glosso and mark setup done first.' : '';
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.pushManager ? registration.pushManager.getSubscription() : null;
}

async function updateServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await registration.update();
  } catch {
    // Push setup reports registration errors when the user taps Enable push.
  }
}

async function get(url) {
  const response = await fetch(apiUrl(url), { headers: headers() });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || response.statusText);
  return json;
}

async function post(url, body = {}) {
  const response = await fetch(apiUrl(url), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || response.statusText);
  write(json);
  return json;
}

function apiUrl(path) {
  return new URL(path, location.origin).toString();
}

function write(value) {
  logEl.textContent = JSON.stringify(value, null, 2);
}

async function run(fn) {
  try {
    await fn();
  } catch (error) {
    write({ error: error.message });
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
