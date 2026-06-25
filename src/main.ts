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

function productStatus(product: Product): { label: string; className: string } {
  if (product.stock <= 0) return { label: 'Agotado', className: 'danger' };
  if (product.stock <= 6) return { label: 'Bajo stock', className: 'warning' };
  return { label: 'OK', className: 'ok' };
}

function soonDate(index: number): string {
  const date = new Date();
  date.setDate(date.getDate() + 30 + index * 9);
  return date.toLocaleDateString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function productCategory(product: Product): string {
  const name = normalizeText(product.name);
  if (name.includes('aceite')) return 'Aceites';
  if (name.includes('arroz') || name.includes('cafe')) return 'Abarrotes';
  if (name.includes('detergente')) return 'Limpieza';
  return 'General';
}

function render(): void {
  const pending = state.movements.filter(item => item.status === 'pending').length;
  const totalStock = state.products.reduce((sum, product) => sum + product.stock, 0);
  const lowStock = state.products.filter(product => product.stock > 0 && product.stock <= 6).length;
  const outOfStock = state.products.filter(product => product.stock <= 0).length;
  const selected = state.products.find(product => product.id === selectedProductId);
  const products = filteredProducts();

  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">◆</span>
          <strong>Inventario <em>Pro</em></strong>
        </div>
        <nav class="nav-list" aria-label="Navegacion principal">
          <a class="active" href="#panel">▦ Panel</a>
          <a href="#inventario">▧ Inventario</a>
          <a href="#scanner">▥ Escanear</a>
          <a href="#historial">↺ Historial</a>
          <a href="#proveedores">♙ Proveedores</a>
        </nav>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-user">
          <span>AD</span>
          <div>
            <strong>Admin</strong>
            <small>uso personal</small>
          </div>
        </div>
        <section class="quick-scanner" id="scanner">
          <header>
            <strong>Escáner rápido</strong>
            <span>⋮</span>
          </header>
          <div class="scanner-frame compact-frame">
            <video id="scanner-video" muted playsinline></video>
            <div class="scanner-overlay">
              <div class="scanner-target"></div>
            </div>
          </div>
          <p id="scanner-status" class="scanner-status">Listo para escanear</p>
          <div class="scanner-actions">
            <button id="start-scanner" class="primary compact">Escanear</button>
            <button id="stop-scanner" class="secondary compact" disabled>Detener</button>
          </div>
        </section>
        <small class="version">v0.2.0</small>
      </aside>

      <div class="workspace">
        <header class="topbar">
          <button class="icon-button" aria-label="Menu">☰</button>
          <label class="global-search">
            <span>⌕</span>
            <input id="search" placeholder="Buscar productos, SKU, EAN o lotes..." value="${escapeHtml(state.query)}">
          </label>
          <div class="status-row">
            <span class="cloud">☁</span>
            <span class="status ${state.online ? 'online' : 'offline'}">${state.online ? 'Sincronizado' : 'Offline'}</span>
            <button id="sync-button" class="secondary">Sincronizar (${pending})</button>
          </div>
        </header>

        <main class="dashboard" id="panel">
          <div class="page-title">
            <div>
              <h1>Panel</h1>
              <p>Resumen operativo de inventario</p>
            </div>
            <div class="toolbar-actions">
              <button class="secondary">Hoy ▾</button>
              <button class="secondary">Filtros</button>
            </div>
          </div>

          <section class="metric-grid">
            <article class="metric-card green">
              <span class="metric-icon">▣</span>
              <div>
                <small>Stock total</small>
                <strong>${totalStock.toLocaleString('es-CL')}</strong>
                <p>unidades</p>
              </div>
            </article>
            <article class="metric-card amber">
              <span class="metric-icon">△</span>
              <div>
                <small>Bajo stock</small>
                <strong>${lowStock}</strong>
                <p>SKUs</p>
              </div>
            </article>
            <article class="metric-card red">
              <span class="metric-icon">□</span>
              <div>
                <small>Agotados</small>
                <strong>${outOfStock}</strong>
                <p>SKUs</p>
              </div>
            </article>
            <article class="metric-card blue">
              <span class="metric-icon">↻</span>
              <div>
                <small>Sincronización</small>
                <strong>${pending === 0 ? '100%' : `${pending}`}</strong>
                <p>${pending === 0 ? 'Sincronizado' : 'pendientes'}</p>
              </div>
            </article>
          </section>

          <section class="main-grid">
            <section class="inventory-card" id="inventario">
              <div class="card-title">
                <div>
                  <h2>Inventario</h2>
                  <span>${products.length} SKUs</span>
                </div>
                <div class="card-actions">
                  <button id="export-button" class="secondary">Exportar</button>
                  <label class="primary import-button">
                    Importar
                    <input id="csv-input" type="file" accept=".csv,text/csv" hidden>
                  </label>
                </div>
              </div>

              <div class="inventory-table">
                <div class="table-row table-head">
                  <span>SKU / EAN</span>
                  <span>Producto</span>
                  <span>Categoría</span>
                  <span>Stock</span>
                  <span>Lote</span>
                  <span>Vencimiento</span>
                  <span>Estado</span>
                  <span></span>
                </div>
                ${products.map((product, index) => {
                  const status = productStatus(product);
                  return `
                    <button class="table-row product-row ${product.id === selectedProductId ? 'selected' : ''}" data-product-id="${product.id}">
                      <span><strong>${escapeHtml(product.ean || product.sap)}</strong><small>${escapeHtml(product.sap)}</small></span>
                      <span class="product-cell"><i>${product.name.slice(0, 1).toUpperCase()}</i><span><strong>${escapeHtml(product.name)}</strong><small>Unidad: ${escapeHtml(product.unit)}</small></span></span>
                      <span>${productCategory(product)}</span>
                      <span class="${status.className === 'ok' ? 'success' : status.className === 'danger' ? 'danger' : 'warn'}">${product.stock.toLocaleString('es-CL')}</span>
                      <span>L${String(index + 1).padStart(4, '0')}</span>
                      <span>${soonDate(index)}</span>
                      <span><mark class="status-pill ${status.className}">${status.label}</mark></span>
                      <span>⋮</span>
                    </button>
                  `;
                }).join('') || '<p class="empty">No hay productos para esta busqueda.</p>'}
              </div>
            </section>

            <aside class="right-panel">
              <section class="side-card">
                <div class="card-title compact-title">
                  <h2>Cola de escaneos</h2>
                  <span>${pending}</span>
                </div>
                <div class="scan-list" id="historial">
                  ${state.movements.slice(0, 6).map(movement => `
                    <article>
                      <span class="scan-icon">▦</span>
                      <div>
                        <strong>${escapeHtml(movement.productName)}</strong>
                        <small>${new Date(movement.createdAt).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</small>
                      </div>
                      <em class="${movement.type === 'out' ? 'danger' : 'success'}">${movement.type === 'out' ? '-' : '+'}${movement.quantity}</em>
                    </article>
                  `).join('') || '<p class="empty">Sin movimientos registrados.</p>'}
                </div>
              </section>

              <section class="side-card movement-panel">
                <div class="card-title compact-title">
                  <h2>Agregar producto rápido</h2>
                </div>
                <label class="field">
                  SKU / EAN
                  <input value="${selected ? escapeHtml(selected.ean || selected.sap) : ''}" readonly placeholder="Escanear o ingresar código">
                </label>
                <label class="field">
                  Producto
                  <input value="${selected ? escapeHtml(selected.name) : ''}" readonly placeholder="Buscar producto...">
                </label>
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
                <button id="movement-button" class="primary">Agregar al inventario</button>
              </section>
            </aside>
          </section>
        </main>
        <footer class="bottom-status">Almacén: <strong>Almacén Central</strong></footer>
      </div>
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
