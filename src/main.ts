import './styles.css';

type DetectedBarcode = {
  rawValue: string;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => {
  detect: (source: HTMLVideoElement) => Promise<DetectedBarcode[]>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

type Product = {
  id: string;
  sap: string;
  ean: string;
  name: string;
  stock: number;
  unit: string;
  updatedAt: string;
};

type Movement = {
  id: string;
  productId: string;
  productName: string;
  type: 'in' | 'out';
  quantity: number;
  reason: string;
  status: 'pending' | 'synced' | 'rejected';
  message: string;
  createdAt: string;
};

const DB_NAME = 'inventario-personal-db';
const DB_VERSION = 1;
const PRODUCTS = 'products';
const MOVEMENTS = 'movements';
const BARCODE_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf'
];

let dbPromise: Promise<IDBDatabase> | null = null;
let selectedProductId = '';
let scannerStream: MediaStream | null = null;
let scannerFrameId = 0;
let scannerDetector: InstanceType<BarcodeDetectorConstructor> | null = null;
let scannerFrameCount = 0;
let scannerStartedAt = 0;

const sampleProducts: Product[] = [
  createProduct('SAP-001', '7800000000012', 'Aceite de oliva 1L', 12, 'unidad'),
  createProduct('SAP-002', '7800000000029', 'Arroz grado 1 1kg', 24, 'unidad'),
  createProduct('SAP-003', '7800000000036', 'Café molido 250g', 8, 'unidad'),
  createProduct('SAP-004', '7800000000043', 'Detergente líquido 3L', 6, 'unidad')
];

function createProduct(sap: string, ean: string, name: string, stock: number, unit: string): Product {
  return {
    id: crypto.randomUUID(),
    sap,
    ean,
    name,
    stock,
    unit,
    updatedAt: new Date().toISOString()
  };
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;

      const products = db.createObjectStore(PRODUCTS, { keyPath: 'id' });
      products.createIndex('sap', 'sap', { unique: true });
      products.createIndex('ean', 'ean', { unique: false });
      products.createIndex('name', 'name', { unique: false });

      const movements = db.createObjectStore(MOVEMENTS, { keyPath: 'id' });
      movements.createIndex('productId', 'productId', { unique: false });
      movements.createIndex('status', 'status', { unique: false });
      movements.createIndex('createdAt', 'createdAt', { unique: false });
    };
  });

  return dbPromise;
}

async function tx<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = action(store);

    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function getAll<T>(storeName: string): Promise<T[]> {
  return tx<T[]>(storeName, 'readonly', store => store.getAll()).then(rows => rows || []);
}

async function saveProduct(product: Product): Promise<void> {
  await tx(PRODUCTS, 'readwrite', store => store.put(product));
}

async function saveMovement(movement: Movement): Promise<void> {
  await tx(MOVEMENTS, 'readwrite', store => store.put(movement));
}

async function seedIfNeeded(): Promise<void> {
  const products = await getAll<Product>(PRODUCTS);
  if (products.length > 0) return;

  for (const product of sampleProducts) {
    await saveProduct(product);
  }
}

function readForm(): { product: Product; type: 'in' | 'out'; quantity: number; reason: string } | null {
  const product = state.products.find(item => item.id === selectedProductId);
  const typeInput = document.querySelector<HTMLInputElement>('input[name="movement-type"]:checked');
  const quantityInput = document.querySelector<HTMLInputElement>('#movement-quantity');
  const reasonInput = document.querySelector<HTMLInputElement>('#movement-reason');
  const quantity = Number(quantityInput?.value || 0);

  if (!product) {
    toast('Selecciona un producto antes de registrar un movimiento.', 'error');
    return null;
  }

  if (!typeInput || !['in', 'out'].includes(typeInput.value)) {
    toast('Selecciona ingreso o egreso.', 'error');
    return null;
  }

  if (!Number.isFinite(quantity) || quantity <= 0) {
    toast('Ingresa una cantidad mayor a cero.', 'error');
    return null;
  }

  return {
    product,
    type: typeInput.value as 'in' | 'out',
    quantity,
    reason: reasonInput?.value.trim() || 'Sin motivo'
  };
}

async function registerMovement(): Promise<void> {
  const form = readForm();
  if (!form) return;

  const nextStock = form.type === 'in'
    ? form.product.stock + form.quantity
    : form.product.stock - form.quantity;

  if (nextStock < 0) {
    toast(`Egreso rechazado: stock disponible actual ${form.product.stock}.`, 'error');
    return;
  }

  const updatedProduct = {
    ...form.product,
    stock: nextStock,
    updatedAt: new Date().toISOString()
  };

  const movement: Movement = {
    id: crypto.randomUUID(),
    productId: form.product.id,
    productName: form.product.name,
    type: form.type,
    quantity: form.quantity,
    reason: form.reason,
    status: 'pending',
    message: 'Pendiente de sincronización manual',
    createdAt: new Date().toISOString()
  };

  await saveProduct(updatedProduct);
  await saveMovement(movement);
  await refresh();
  toast('Movimiento registrado localmente.', 'success');
}

async function syncNow(): Promise<void> {
  const pending = state.movements.filter(item => item.status === 'pending');
  if (pending.length === 0) {
    toast('No hay movimientos pendientes.', 'success');
    return;
  }

  for (const movement of pending) {
    await saveMovement({
      ...movement,
      status: 'synced',
      message: 'Sincronización local simulada. Backend pendiente.'
    });
  }

  await refresh();
  toast(`${pending.length} movimiento(s) marcados como sincronizados.`, 'success');
}

async function importCsv(file: File): Promise<void> {
  const text = await file.text();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const [headerLine, ...rows] = lines;
  const headers = splitCsvLine(headerLine).map(item => item.toLowerCase().trim());
  const required = ['sap', 'ean', 'name', 'stock', 'unit'];
  const missing = required.filter(key => !headers.includes(key));

  if (missing.length > 0) {
    toast(`CSV inválido. Faltan columnas: ${missing.join(', ')}.`, 'error');
    return;
  }

  let imported = 0;
  const existing = await getAll<Product>(PRODUCTS);
  const sapSet = new Set(existing.map(product => product.sap));

  for (const row of rows) {
    const cells = splitCsvLine(row);
    const value = (key: string) => cells[headers.indexOf(key)]?.trim() || '';
    const stock = Number(value('stock'));

    if (!value('sap') || !value('name') || !Number.isFinite(stock) || stock < 0 || sapSet.has(value('sap'))) {
      continue;
    }

    await saveProduct(createProduct(value('sap'), value('ean'), value('name'), stock, value('unit') || 'unidad'));
    sapSet.add(value('sap'));
    imported += 1;
  }

  await refresh();
  toast(`Importación lista: ${imported} producto(s) agregados.`, 'success');
}

function splitCsvLine(line = ''): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells.map(cell => cell.replace(/^"|"$/g, ''));
}

function exportCsv(): void {
  const rows = [
    ['sap', 'ean', 'name', 'stock', 'unit', 'updatedAt'],
    ...state.products.map(product => [product.sap, product.ean, product.name, String(product.stock), product.unit, product.updatedAt])
  ];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `inventario-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function startScanner(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Este navegador no permite usar la cámara.', 'error');
    return;
  }

  if (!window.BarcodeDetector) {
    toast('Este navegador no soporta BarcodeDetector. Prueba Chrome/Edge en Android o escritorio.', 'error');
    return;
  }

  if (scannerStream) {
    toast('El escáner ya está activo.', 'success');
    return;
  }

  const video = document.querySelector<HTMLVideoElement>('#scanner-video');
  const status = document.querySelector<HTMLParagraphElement>('#scanner-status');
  if (!video || !status) return;

  try {
    scannerDetector = new window.BarcodeDetector({ formats: BARCODE_FORMATS });
  } catch (error) {
    console.warn('BarcodeDetector no disponible para los formatos solicitados.', error);
    toast('Este navegador no soporta escaneo de códigos de barra compatible.', 'error');
    return;
  }

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        frameRate: { ideal: 120, min: 30 },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    const [track] = scannerStream.getVideoTracks();
    await applyHighFrameRate(track);

    video.srcObject = scannerStream;
    await video.play();

    scannerFrameCount = 0;
    scannerStartedAt = performance.now();
    status.textContent = 'Escaneando... apunta al código de barra.';
    updateScannerControls(true);
    scannerFrameId = requestAnimationFrame(scanFrame);
  } catch (error) {
    console.error(error);
    stopScanner();
    toast('No se pudo iniciar la cámara. Revisa permisos del navegador.', 'error');
  }
}

async function applyHighFrameRate(track: MediaStreamTrack): Promise<void> {
  const capabilities = track.getCapabilities?.();
  const maxFrameRate = capabilities?.frameRate?.max;
  const targetFrameRate = Math.min(120, maxFrameRate || 120);

  try {
    await track.applyConstraints({
      advanced: [{ frameRate: targetFrameRate }]
    });
  } catch (error) {
    console.info('No se pudo aplicar 120 fps; se usará el máximo disponible.', error);
  }
}

async function scanFrame(): Promise<void> {
  const video = document.querySelector<HTMLVideoElement>('#scanner-video');
  const status = document.querySelector<HTMLParagraphElement>('#scanner-status');
  if (!video || !status || !scannerDetector || !scannerStream) return;

  scannerFrameCount += 1;
  const elapsedSeconds = (performance.now() - scannerStartedAt) / 1000;
  if (elapsedSeconds > 0.5) {
    const fps = Math.round(scannerFrameCount / elapsedSeconds);
    status.textContent = `Escaneando a ~${fps} fps. Objetivo solicitado: 120 fps.`;
  }

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    try {
      const codes = await scannerDetector.detect(video);
      const code = codes[0]?.rawValue?.trim();
      if (code) {
        await handleScannedCode(code);
        return;
      }
    } catch (error) {
      console.warn('Error detectando código.', error);
    }
  }

  scannerFrameId = requestAnimationFrame(scanFrame);
}

async function handleScannedCode(code: string): Promise<void> {
  stopScanner();
  const product = state.products.find(item => item.ean === code || item.sap === code);

  if (product) {
    selectedProductId = product.id;
    state.query = code;
    await refresh();
    toast(`Código detectado: ${code}. Producto seleccionado.`, 'success');
    return;
  }

  state.query = code;
  await refresh();
  toast(`Código detectado: ${code}. No está en el catálogo.`, 'error');
}

function stopScanner(): void {
  if (scannerFrameId) {
    cancelAnimationFrame(scannerFrameId);
    scannerFrameId = 0;
  }

  scannerStream?.getTracks().forEach(track => track.stop());
  scannerStream = null;
  scannerDetector = null;

  const video = document.querySelector<HTMLVideoElement>('#scanner-video');
  const status = document.querySelector<HTMLParagraphElement>('#scanner-status');
  if (video) video.srcObject = null;
  if (status) status.textContent = 'Cámara detenida.';
  updateScannerControls(false);
}

function updateScannerControls(active: boolean): void {
  const startButton = document.querySelector<HTMLButtonElement>('#start-scanner');
  const stopButton = document.querySelector<HTMLButtonElement>('#stop-scanner');
  if (startButton) startButton.disabled = active;
  if (stopButton) stopButton.disabled = !active;
}

const state: { products: Product[]; movements: Movement[]; query: string; online: boolean } = {
  products: [],
  movements: [],
  query: '',
  online: navigator.onLine
};

function filteredProducts(): Product[] {
  const query = normalizeText(state.query);
  if (!query) return state.products;

  return state.products.filter(product => {
    return normalizeText(product.sap).includes(query)
      || normalizeText(product.ean).includes(query)
      || normalizeText(product.name).includes(query);
  });
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function refresh(): Promise<void> {
  state.products = (await getAll<Product>(PRODUCTS)).sort((a, b) => a.name.localeCompare(b.name));
  state.movements = (await getAll<Movement>(MOVEMENTS)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!state.products.some(product => product.id === selectedProductId)) {
    selectedProductId = state.products[0]?.id || '';
  }
  render();
}

function toast(message: string, type: 'success' | 'error'): void {
  const toastEl = document.querySelector<HTMLDivElement>('#toast');
  if (!toastEl) return;

  toastEl.textContent = message;
  toastEl.className = `toast ${type} visible`;
  window.setTimeout(() => {
    toastEl.classList.remove('visible');
  }, 3200);
}

function render(): void {
  const pending = state.movements.filter(item => item.status === 'pending').length;
  const totalStock = state.products.reduce((sum, product) => sum + product.stock, 0);
  const selected = state.products.find(product => product.id === selectedProductId);
  const products = filteredProducts();

  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div>
          <strong>Inventario Personal</strong>
          <span>Primera version offline</span>
        </div>
        <div class="status-row">
          <span class="status ${state.online ? 'online' : 'offline'}">${state.online ? 'Online' : 'Offline'}</span>
          <button id="sync-button" class="secondary">Sincronizar ahora (${pending})</button>
        </div>
      </header>

      <main class="layout">
        <section class="hero">
          <div>
            <p class="eyebrow">Control simple</p>
            <h1>Stock personal sin complicarse.</h1>
            <p>Busca por SAP, EAN o nombre; registra ingresos y egresos; importa y exporta CSV.</p>
          </div>
          <div class="metric-card">
            <span>Stock total</span>
            <strong>${totalStock.toLocaleString('es-CL')}</strong>
            <small>${state.products.length} productos</small>
          </div>
        </section>

        <section class="panel products-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Catalogo</p>
              <h2>Productos</h2>
            </div>
            <label class="import-button">
              Importar CSV
              <input id="csv-input" type="file" accept=".csv,text/csv" hidden>
            </label>
          </div>

          <input id="search" class="search" placeholder="Buscar SAP, EAN o nombre..." value="${escapeHtml(state.query)}">

          <div class="product-list">
            ${products.map(product => `
              <button class="product-row ${product.id === selectedProductId ? 'selected' : ''}" data-product-id="${product.id}">
                <span>
                  <strong>${escapeHtml(product.name)}</strong>
                  <small>${escapeHtml(product.sap)} · ${escapeHtml(product.ean || 'sin EAN')}</small>
                </span>
                <em>${product.stock.toLocaleString('es-CL')} ${escapeHtml(product.unit)}</em>
              </button>
            `).join('') || '<p class="empty">No hay productos para esta busqueda.</p>'}
          </div>
        </section>

        <section class="panel scanner-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Escaner</p>
              <h2>Código de barra</h2>
            </div>
            <span class="fps-badge">120 fps ideal</span>
          </div>

          <div class="scanner-frame">
            <video id="scanner-video" muted playsinline></video>
            <div class="scanner-overlay">
              <div class="scanner-target"></div>
            </div>
          </div>

          <p id="scanner-status" class="scanner-status">
            Listo. La app solicitará cámara trasera y 120 fps si el dispositivo lo permite.
          </p>

          <div class="scanner-actions">
            <button id="start-scanner" class="primary compact">Iniciar escáner</button>
            <button id="stop-scanner" class="secondary compact" disabled>Detener</button>
          </div>
        </section>

        <section class="panel movement-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Movimiento</p>
              <h2>${selected ? escapeHtml(selected.name) : 'Selecciona producto'}</h2>
            </div>
            <button id="export-button" class="secondary">Exportar CSV</button>
          </div>

          <div class="stock-card">
            <span>Stock actual</span>
            <strong>${selected ? selected.stock.toLocaleString('es-CL') : '0'} ${selected ? escapeHtml(selected.unit) : ''}</strong>
          </div>

          <div class="movement-type">
            <label><input type="radio" name="movement-type" value="in" checked> Ingreso</label>
            <label><input type="radio" name="movement-type" value="out"> Egreso</label>
          </div>

          <label class="field">
            Cantidad
            <input id="movement-quantity" type="number" min="0" step="0.01" placeholder="0">
          </label>

          <label class="field">
            Motivo
            <input id="movement-reason" placeholder="Compra, consumo, ajuste...">
          </label>

          <button id="movement-button" class="primary">Registrar movimiento</button>
        </section>

        <section class="panel history-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Registro</p>
              <h2>Ultimos movimientos</h2>
            </div>
          </div>

          <div class="movement-list">
            ${state.movements.slice(0, 10).map(movement => `
              <article class="movement-row">
                <span>
                  <strong>${escapeHtml(movement.productName)}</strong>
                  <small>${new Date(movement.createdAt).toLocaleString('es-CL')} · ${escapeHtml(movement.reason)}</small>
                </span>
                <em class="${movement.type === 'out' ? 'danger' : 'success'}">
                  ${movement.type === 'out' ? '-' : '+'}${movement.quantity.toLocaleString('es-CL')}
                  <small>${movement.status}</small>
                </em>
              </article>
            `).join('') || '<p class="empty">Aun no hay movimientos.</p>'}
          </div>
        </section>
      </main>
      <div id="toast" class="toast"></div>
    </div>
  `;

  bindEvents();
}

function bindEvents(): void {
  document.querySelector<HTMLInputElement>('#search')?.addEventListener('input', event => {
    state.query = (event.target as HTMLInputElement).value;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>('.product-row').forEach(button => {
    button.addEventListener('click', () => {
      selectedProductId = button.dataset.productId || '';
      render();
    });
  });

  document.querySelector<HTMLButtonElement>('#movement-button')?.addEventListener('click', registerMovement);
  document.querySelector<HTMLButtonElement>('#sync-button')?.addEventListener('click', syncNow);
  document.querySelector<HTMLButtonElement>('#export-button')?.addEventListener('click', exportCsv);
  document.querySelector<HTMLButtonElement>('#start-scanner')?.addEventListener('click', startScanner);
  document.querySelector<HTMLButtonElement>('#stop-scanner')?.addEventListener('click', stopScanner);
  document.querySelector<HTMLInputElement>('#csv-input')?.addEventListener('change', event => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) importCsv(file);
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char] || char);
}

window.addEventListener('online', () => {
  state.online = true;
  render();
});

window.addEventListener('offline', () => {
  state.online = false;
  render();
});

if ('serviceWorker' in navigator && !isLocalDevHost()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.warn('No se pudo registrar el service worker.', error);
    });
  });
}

function isLocalDevHost(): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
}

await openDb();
await seedIfNeeded();
await refresh();
