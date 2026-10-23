import { useEffect, useRef } from 'react'
import { performDrop } from '../lib/actions'
import { currentDrag, decodeDrag, dropPlan, endDrag, type DropContext, type DropPlan, type DropTarget } from '../lib/dnd'
import { useStore } from '../lib/store'

/**
 * Drag and drop for the whole window, in one place (ADR-009).
 *
 * Drop targets do not handle drag events themselves. Each carries `data-drop-target` (the
 * DropTarget as JSON); graph rows add `data-drop-zones="thirds"` because where on the row matters
 * (above, onto, below). Document-level listeners find the target under the pointer, ask
 * `dropPlan` what the drop would do with the Alt key as it is now, and then either accept the
 * drag (preventDefault: the pointer says "move") and show the plan, or leave it refused.
 *
 * The badge that follows the pointer is the discoverability: it says exactly what will happen,
 * and what Alt would do instead. It is moved and relabelled by writing to its style and text
 * directly, never through React state: dragover fires many times a second and nothing else on
 * screen needs to re-render for it. The target's highlight is an attribute on the target
 * (`data-drop-active`, styled in styles.css), set and cleared the same way.
 */
export function DragBadge() {
  const badge = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const alt = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let lit: Element | null = null
    const light = (el: Element | null, how?: string) => {
      if (lit && lit !== el) lit.removeAttribute('data-drop-active')
      lit = el
      if (el && how) el.setAttribute('data-drop-active', how)
    }
    const hide = () => {
      light(null)
      if (badge.current) badge.current.style.display = 'none'
    }

    /** The target under the pointer and what dropping there would do (with Alt as held now). */
    const planAt = (e: DragEvent): { id: string; el: Element; target: DropTarget; plan: DropPlan; other: DropPlan | null } | null => {
      const source = currentDrag() ?? (e.type === 'drop' && e.dataTransfer ? decodeDrag((m) => e.dataTransfer!.getData(m)) : null)
      const el = (e.target as Element | null)?.closest?.('[data-drop-target]')
      const s = useStore.getState()
      const view = s.active ? s.repos[s.active] : undefined
      if (!source || !el || !view) return null
      let target: DropTarget
      try {
        target = JSON.parse(el.getAttribute('data-drop-target')!) as DropTarget
      } catch {
        return null
      }
      if (target.kind === 'row' && el.getAttribute('data-drop-zones') === 'thirds') {
        const box = el.getBoundingClientRect()
        const y = (e.clientY - box.top) / box.height
        target = { ...target, where: y < 1 / 3 ? 'above' : y > 2 / 3 ? 'below' : 'onto' }
      }
      const ctx: DropContext = { snapshot: view.snapshot, editable: view.editable, pinned: view.pins }
      const plan = dropPlan(ctx, source, target, { alt: e.altKey })
      if (!plan) return null
      const other = dropPlan(ctx, source, target, { alt: !e.altKey })
      return { id: view.id, el, target, plan, other: other && other.label !== plan.label ? other : null }
    }

    const onOver = (e: DragEvent) => {
      const at = planAt(e)
      if (!at) return hide()
      // Accepting the drag is what lets it drop here (and gives the "move" pointer).
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      // A line between rows only where commits will land between rows; anything else outlines the target.
      light(at.el, at.plan.op.op === 'move' ? at.plan.op.where : 'on')
      const b = badge.current
      if (!b || !label.current || !alt.current) return
      label.current.textContent = at.plan.label + (at.plan.confirm ? ' (asks first)' : '')
      alt.current.textContent = at.other ? `${e.altKey ? 'Without Alt' : 'Alt'}: ${at.other.label}` : ''
      alt.current.style.display = at.other ? '' : 'none'
      b.style.display = ''
      b.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 18}px)`
    }
    const onDrop = (e: DragEvent) => {
      const at = planAt(e)
      hide()
      endDrag()
      if (!at) return
      e.preventDefault()
      performDrop(at.id, at.plan)
    }
    const onEnd = () => {
      hide()
      endDrag()
    }
    // Leaving the window: no target, no badge (dragover outside never arrives).
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) hide()
    }
    document.addEventListener('dragover', onOver)
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragend', onEnd)
    document.addEventListener('dragleave', onLeave)
    return () => {
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragend', onEnd)
      document.removeEventListener('dragleave', onLeave)
    }
  }, [])

  return (
    <div ref={badge} data-testid="drag-badge" style={{ display: 'none', position: 'fixed', left: 0, top: 0 }}
      className="pointer-events-none z-50 flex max-w-96 flex-col rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-lg">
      <span ref={label} data-testid="drag-badge-label" />
      <span ref={alt} data-testid="drag-badge-alt" className="text-2xs font-normal opacity-80" />
    </div>
  )
}
