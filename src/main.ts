import './styles.css';

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

let dbPromise: Promise<IDBDatabase> | null = null;
let selectedProductId = '';

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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(error => {
      console.warn('No se pudo registrar el service worker.', error);
    });
  });
}

await openDb();
await seedIfNeeded();
await refresh();
