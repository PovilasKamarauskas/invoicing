import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon'
import SavedItemInput from './SavedItemInput'
import rules from 'invoice-rules'

export interface LineItemDto {
  description: string
  quantity: number
  unit: string
  price: number
}

interface Props {
  items: LineItemDto[]
  onChange: (items: LineItemDto[]) => void
  savedItems: string[]
  onSaveItem: (description: string) => Promise<string[]>
  errors?: Record<string, string>
}

const UNITS = ['d', 'h', 'pcs', 'month']

function NumericInput({ value, label, step, invalid, onChange }: { value: number; label: string; step: number; invalid: boolean; onChange: (value: number) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(String(value))
  }, [value])
  return <input ref={input} type="number" aria-label={label} aria-invalid={invalid} min={0} step={step} value={draft}
    onChange={event => { setDraft(event.target.value); onChange(parseFloat(event.target.value) || 0) }}
    onBlur={() => setDraft(String(value))} />
}

export default function LineItems({
  items,
  onChange,
  savedItems,
  onSaveItem,
  errors = {},
}: Props) {
  const [saveMessage, setSaveMessage] = useState('')
  const helpId = useId()

  const saveDescription = async (idx: number) => {
    const description = items[idx].description.trim()
    if (!description) return
    setSaveMessage('Saving item…')
    try {
      const saved = await onSaveItem(description)
      const canonical =
        saved.find(
          (item) =>
            item.toLocaleLowerCase() === description.toLocaleLowerCase(),
        ) || description
      setSaveMessage(`“${canonical}” saved to your account.`)
    } catch {
      setSaveMessage(
        'Could not save this item. Please check your connection and try again.',
      )
    }
  }

  const update = (
    idx: number,
    field: keyof LineItemDto,
    value: string | number,
  ) => {
    const next = items.map((item, i) =>
      i === idx ? { ...item, [field]: value } : item,
    )
    onChange(next)
  }

  const addRow = () => {
    onChange([...items, { description: '', quantity: 1, unit: 'd', price: 0 }])
  }

  const removeRow = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx))
  }

  let amounts = { lines: items.map(() => 0), total: 0 }
  try { amounts = rules.calculate(items) } catch { /* Invalid input is reported at generation. */ }

  return (
    <div>
      <p className="item-description-help" id={helpId}>
        Choose a saved item using the dropdown arrow, or type a new description
        and press Enter to save it.
      </p>
      {errors.items && <p className="error-msg" role="alert">{errors.items}</p>}
      <div
        className="items-table-scroll"
        role="region"
        aria-label="Invoice line items"
        tabIndex={0}
      >
        <table className="items-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>Description</th>
              <th style={{ width: 80 }}>Qty</th>
              <th style={{ width: 90 }}>Unit</th>
              <th style={{ width: 100 }}>Price (€)</th>
              <th style={{ width: 100 }}>Subtotal</th>
              <th style={{ width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={idx}>
                <td className="row-number">{idx + 1}</td>
                <td>
                  <SavedItemInput
                    value={item.description}
                    savedItems={savedItems}
                    label={`Description for item ${idx + 1}`}
                    helpId={helpId}
                    onChange={(value) => update(idx, 'description', value)}
                    onSave={() => saveDescription(idx)}
                  />
                  {errors[`items.${idx}.description`] && <p className="error-msg">{errors[`items.${idx}.description`]}</p>}
                </td>
                <td>
                  <NumericInput
                    label={`Quantity for item ${idx + 1}`}
                    value={item.quantity}
                    step={0.001}
                    invalid={!!errors[`items.${idx}.quantity`]}
                    onChange={(value) => update(idx, 'quantity', value)}
                  />
                  {errors[`items.${idx}.quantity`] && <p className="error-msg">{errors[`items.${idx}.quantity`]}</p>}
                </td>
                <td>
                  <select
                    aria-label={`Unit for item ${idx + 1}`}
                    value={item.unit}
                    onChange={(e) => update(idx, 'unit', e.target.value)}
                  >
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <NumericInput
                    label={`Price in euros for item ${idx + 1}`}
                    value={item.price}
                    step={0.01}
                    invalid={!!errors[`items.${idx}.price`]}
                    onChange={(value) => update(idx, 'price', value)}
                  />
                  {errors[`items.${idx}.price`] && <p className="error-msg">{errors[`items.${idx}.price`]}</p>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {amounts.lines[idx].toFixed(2)}
                </td>
                <td>
                  <button
                    className="btn btn-danger"
                    aria-label={`Remove item ${idx + 1}`}
                    onClick={() => removeRow(idx)}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="items-footer">
        <button className="btn btn-secondary" onClick={addRow}>
          <Icon name="plus" /> Add item
        </button>
        <div className="total-display">Subtotal: €{amounts.total.toFixed(2)}</div>
      </div>
      <p className="item-save-message" role="status">
        {saveMessage}
      </p>
    </div>
  )
}
