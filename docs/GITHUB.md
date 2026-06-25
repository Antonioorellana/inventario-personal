# Publicacion en GitHub

Este proyecto debe vivir en un repositorio nuevo, separado de `superscan`.

## Nombre recomendado

`inventario-personal`

## Estado local

Repositorio local ya inicializado:

```bash
cd "/Volumes/Disco01/proyectos/proyecto 1/inventario-personal"
git log --oneline
```

## Publicar cuando exista el repo vacio

Crear un repositorio vacio en GitHub llamado `inventario-personal` y luego ejecutar:

```bash
git remote add origin git@github.com:Antonioorellana/inventario-personal.git
git push -u origin main
```

Si el repo usa otra cuenta u organizacion, cambiar `Antonioorellana` por el owner correcto.

## Notas

- No publicar dentro de `Antonioorellana/superscan`.
- Mantener commits pequenos como puntos de retorno.
- Antes de cada push estable, ejecutar `npm run build`.
