# Inventario Personal

Primera version basica de una PWA personal para gestionar inventario.

## Objetivo

Tener una app simple, instalable y offline-first para:

- Buscar productos por SAP, EAN o nombre.
- Escanear códigos de barra con cámara cuando el navegador soporte `BarcodeDetector`.
- Ver stock actual.
- Registrar ingresos y egresos.
- Evitar egresos con stock local insuficiente.
- Guardar movimientos pendientes en IndexedDB.
- Sincronizar manualmente, por ahora de forma local simulada.
- Importar productos desde CSV.
- Exportar inventario a CSV.

## Estado actual

Esta version no usa backend. La prioridad es una base funcional y facil de mejorar.

## Deploy

Produccion en Vercel:

https://inventario-personal-mu.vercel.app

Proyecto conectado a GitHub:

https://github.com/Antonioorellana/inventario-personal

Datos locales:

- `products`: catalogo y stock local.
- `movements`: movimientos de stock.

Persistencia:

- IndexedDB nativo del navegador.
- Service worker basico para PWA.

## Scripts

```bash
npm install
npm run dev
npm run build
```

## CSV de importacion

El archivo debe usar estas columnas:

```csv
sap,ean,name,stock,unit
SAP-010,7800000000104,Producto ejemplo,5,unidad
```

Reglas actuales:

- `sap`, `name`, `stock` son obligatorios.
- `stock` debe ser numero mayor o igual a 0.
- SAP duplicado se omite.

## Camino recomendado

1. Mantener esta version simple y estable.
2. Agregar tests basicos.
3. Agregar exportacion de movimientos.
4. Reemplazar sincronizacion simulada por Supabase cuando haga falta.
5. Agregar autenticacion solo si realmente se necesita.

## Seguridad

Uso personal, seguridad minima:

- No se guardan tokens.
- No hay login todavia.
- Validaciones criticas son locales y simples.
- Cuando exista backend, el stock real debera validarse del lado servidor.

## Escaner de codigo de barra

La app solicita:

- Cámara trasera (`facingMode: environment`).
- `frameRate` ideal de 120 fps, con mínimo de 30 fps.
- Formatos comunes: EAN-13, EAN-8, UPC, Code 128, Code 39 e ITF.

Notas:

- 120 fps no se puede garantizar desde una app web; depende de cámara, navegador, sistema operativo y permisos.
- El escáner usa `BarcodeDetector`, disponible principalmente en navegadores Chromium modernos.
- En iPhone/Safari puede no estar disponible; en ese caso se mantiene la búsqueda manual por SAP/EAN/nombre.
