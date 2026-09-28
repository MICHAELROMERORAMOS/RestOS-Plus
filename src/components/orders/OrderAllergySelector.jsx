import React from 'react'

export function normalizeOrderAllergySelection(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item?.allergenId)
    .map((item) => ({
      allergenId: item.allergenId,
      subtypeIds: Array.from(new Set(
        (Array.isArray(item.subtypeIds) ? item.subtypeIds : []).filter(Boolean),
      )),
    }))
}

export default function OrderAllergySelector({
  catalog = [],
  value = [],
  onChange,
  disabled = false,
}) {
  const selection = normalizeOrderAllergySelection(value)

  const selectedFor = (allergenId) => (
    selection.find((item) => String(item.allergenId) === String(allergenId)) || null
  )

  const toggleAllergen = (allergenId, enabled) => {
    if (disabled) return

    if (!enabled) {
      onChange?.(selection.filter((item) => String(item.allergenId) !== String(allergenId)))
      return
    }

    if (selectedFor(allergenId)) return
    onChange?.([...selection, { allergenId, subtypeIds: [] }])
  }

  const toggleSubtype = (allergenId, subtypeId, enabled) => {
    if (disabled) return

    onChange?.(selection.map((item) => {
      if (String(item.allergenId) !== String(allergenId)) return item
      const current = Array.isArray(item.subtypeIds) ? item.subtypeIds : []
      return {
        ...item,
        subtypeIds: enabled
          ? Array.from(new Set([...current, subtypeId]))
          : current.filter((id) => String(id) !== String(subtypeId)),
      }
    }))
  }

  return (
    <div className="order-allergy-selector">
      <div className="order-allergy-selector-intro">
        <strong>¿El cliente declaró alguna alergia?</strong>
        <p>
          Selecciona únicamente lo que el cliente haya declarado. Esta información se enviará con la comanda a Cocina/Bar.
        </p>
      </div>

      <div className="order-allergy-options">
        {(catalog || []).map((allergen) => {
          const selected = selectedFor(allergen.id)
          const subtypeIds = selected?.subtypeIds || []

          return (
            <article
              className={`order-allergy-option ${selected ? 'selected' : ''}`}
              key={allergen.id}
            >
              <label className="order-allergy-main-check">
                <input
                  type="checkbox"
                  checked={Boolean(selected)}
                  disabled={disabled}
                  onChange={(event) => toggleAllergen(allergen.id, event.target.checked)}
                />
                <span className="order-allergy-option-icon">{allergen.icon || '⚠'}</span>
                <span>
                  <b>{allergen.nameEs}</b>
                  <small>{allergen.nameEn}</small>
                </span>
              </label>

              {selected && (allergen.subtypes || []).length > 0 && (
                <div className="order-allergy-subtypes">
                  <span>Detalle opcional</span>
                  <div>
                    {(allergen.subtypes || []).map((subtype) => {
                      const checked = subtypeIds.some((id) => String(id) === String(subtype.id))
                      return (
                        <label className={checked ? 'selected' : ''} key={subtype.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={(event) => toggleSubtype(
                              allergen.id,
                              subtype.id,
                              event.target.checked,
                            )}
                          />
                          <span>{subtype.nameEs}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

      {!catalog.length && (
        <div className="notice warn">
          No se pudo cargar el catálogo de alérgenos. Actualiza el menú antes de registrar alergias.
        </div>
      )}

      <div className="order-allergy-safety-note">
        <b>Importante:</b> RestOS+ muestra coincidencias según la información registrada en los productos.
        La ausencia de una coincidencia no significa que un alimento sea seguro ni elimina el riesgo de contaminación cruzada.
      </div>
    </div>
  )
}
