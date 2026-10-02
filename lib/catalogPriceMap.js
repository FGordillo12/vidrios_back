const roots = ['azul', 'verde', 'bronce'];

function mapLegacyPrice(tipoInput, grosorInput) {
  const tipo = String(tipoInput || '').trim().toLowerCase();
  const grosor = String(grosorInput || '').trim();
  if (!tipo || !grosor) return null;

  if (tipo === 'laminado') {
    const grosorMm = grosor === '3+3' ? '6' : grosor === '4+4' ? '8' : null;
    return grosorMm ? { tipo: 'transparente laminado', variante: grosor, grosorMm } : null;
  }

  if (tipo === 'transparente') return { tipo, variante: 'normal', grosorMm: grosor };
  if (tipo === 'gris') return { tipo, variante: 'normal', grosorMm: grosor };
  if (tipo === 'grabado' || tipo === 'espejo') return { tipo, variante: '', grosorMm: grosor };

  for (const root of roots) {
    if (tipo === root) {
      return { tipo: root, variante: root === 'bronce' ? '' : 'normal', grosorMm: grosor };
    }
    if (tipo.startsWith(`${root} `)) {
      return { tipo: root, variante: tipo.slice(root.length + 1).trim(), grosorMm: grosor };
    }
  }

  return null;
}

function mapCatalogPrice({ tipo: tipoInput, variante: varianteInput, grosorMm: grosorInput }) {
  const tipo = String(tipoInput || '').trim().toLowerCase();
  const variante = String(varianteInput || '').trim().toLowerCase();
  const grosorMm = String(grosorInput || '').trim();
  if (!tipo || !grosorMm) return null;

  if (tipo === 'transparente laminado') {
    const grosor = variante === '3+3' || variante === '4+4' ? variante : null;
    return grosor ? { tipo: 'laminado', grosor } : null;
  }

  let legacyType = tipo;
  if (variante && variante !== 'normal') legacyType = `${tipo} ${variante}`;
  else if (tipo === 'bronce' && variante === 'normal') legacyType = 'bronce normal';
  return { tipo: legacyType, grosor: grosorMm };
}

module.exports = { mapLegacyPrice, mapCatalogPrice };
