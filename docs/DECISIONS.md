# Decisiones Tecnicas

## 2026-06-25 - Proyecto separado de superscan

Decision: crear `inventario-personal` como proyecto independiente.

Motivo: `superscan` tiene otro objetivo y no debe mezclarse con esta app nueva.

## 2026-06-25 - Primera version sin backend

Decision: usar una PWA local con IndexedDB y sincronizacion simulada.

Motivo: el uso es personal y la prioridad es tener una version basica, recuperable y facil de mejorar.

Consecuencia: no hay seguridad de servidor ni control real de concurrencia todavia.

## 2026-06-25 - TypeScript + Vite sin framework pesado

Decision: usar Vite con TypeScript y DOM nativo.

Motivo: reduce dependencias, simplifica el arranque y evita gastar tiempo en infraestructura antes de validar el flujo.

## 2026-06-25 - Git como puntos de retorno

Decision: cada avance estable debe quedar en commit.

Motivo: permite volver a estados buenos si una mejora rompe la app.

## 2026-06-25 - Busqueda tolerante a acentos

Decision: normalizar texto al buscar productos.

Motivo: en uso diario es esperable escribir `cafe` y encontrar `Cafe` o `Café`.

## 2026-06-25 - Escaner con BarcodeDetector

Decision: usar la API nativa `BarcodeDetector` antes de sumar librerias externas.

Motivo: mantiene la primera version liviana y permite escaneo rapido donde el navegador lo soporta.

Nota: la app solicita 120 fps, pero el frame rate real depende del dispositivo y navegador.
