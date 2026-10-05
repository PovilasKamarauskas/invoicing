import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  value: string
  savedItems: string[]
  label: string
  helpId: string
  onChange: (value: string) => void
  onSave: () => void
}

export default function SavedItemInput({ value, savedItems, label, helpId, onChange, onSave }: Props) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const field = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(true)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 220, maxHeight: 240 })
  const options = showAll ? savedItems : savedItems.filter(item => item.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()))

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = field.current!.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24)
      const below = window.innerHeight - rect.bottom - 16
      const maxHeight = Math.min(240, Math.max(80, below >= 120 ? below : rect.top - 16))
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below >= 120 ? rect.bottom + 5 : Math.max(12, rect.top - maxHeight - 5), width, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const choose = (description: string) => {
    onChange(description)
    setOpen(false)
    setActive(-1)
    input.current?.focus()
  }

  return (
    <div className="saved-item-field" ref={field}>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label={label}
        aria-describedby={helpId}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && options[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        value={value}
        placeholder="Type or choose an item"
        onClick={() => { setShowAll(true); setOpen(true); setActive(-1) }}
        onBlur={() => { setOpen(false); setActive(-1) }}
        onChange={e => { onChange(e.target.value); setShowAll(false); setOpen(true); setActive(-1) }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) { setShowAll(true); setOpen(true); setActive(-1); return }
            setActive(previous => options.length ? e.key === 'ArrowDown' ? Math.min(previous + 1, options.length - 1) : previous <= 0 ? options.length - 1 : previous - 1 : -1)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (open && active >= 0 && options[active]) choose(options[active])
            else { onSave(); setOpen(false); setActive(-1) }
          } else if (e.key === 'Escape') { setOpen(false); setActive(-1) }
        }}
      />
      <button
        type="button"
        className="saved-item-toggle"
        aria-label={`Show saved items for ${label.toLocaleLowerCase()}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        tabIndex={-1}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { input.current?.focus(); setShowAll(true); setActive(-1); setOpen(!open) }}
      ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
      {open && createPortal(
        <div className="saved-item-menu" id={id} role="listbox" aria-label="Saved item descriptions" style={position} onMouseDown={e => e.preventDefault()}>
          {options.length ? options.map((description, index) => (
            <div key={description} id={`${id}-${index}`} role="option" aria-selected={active === index} className={`saved-item-option${active === index ? ' is-active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => choose(description)}>{description}</div>
          )) : <div className="saved-item-empty">{savedItems.length ? 'No matching items. Press Enter to save.' : 'Type an item and press Enter to save it.'}</div>}
        </div>, document.body,
      )}
    </div>
  )
}
