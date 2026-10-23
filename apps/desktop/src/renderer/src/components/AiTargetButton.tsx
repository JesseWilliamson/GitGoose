import type { AiArea } from '@gitgoose/shared'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ModelPicker, useTargetLabel } from './ModelPicker'
import { PromptButton } from './PromptPanel'

/**
 * Who answers, in one small button: "Claude · default". It is the same control in every AI area
 * (Details' Explain row, the commit box, the AI pane's composer, the review / walkthrough / impact
 * rails, Recompose), so a user learns it once.
 *
 * Why a button and not the two selects it replaced: the pick is made once and then left alone, but
 * two selects and a Prompt button took a full row of every surface they were on, and being the
 * only bordered controls there they were louder than the thing the surface is for. Hidden behind
 * one quiet button, the choice is still one click away and says what it currently is. The popover
 * holds the two selects (who, and which model) and the Prompt editor, all for this area.
 */
export function AiTargetButton({ area, className, agentsOnly, onPicked }: {
  area: AiArea
  className?: string
  /** Only agents can answer here (resolving a conflict edits a file; the API only writes text). */
  agentsOnly?: boolean
  /** After a pick is saved (Recompose restarts its request on the new pick). */
  onPicked?: () => void
}) {
  const label = useTargetLabel(area)
  if (!label) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button data-testid={`ai-target-${area}`} title={`Answers with ${label}: change who answers, or edit the prompt`}
          className={cn('inline-flex h-row min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground', className)}>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown size={10} className="shrink-0 text-hint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-3" data-testid={`ai-target-panel-${area}`}
        // Keys typed here are the popover's (Recompose's Ctrl+Z must not step its plan).
        onKeyDown={(e) => e.stopPropagation()}>
        <div className="text-2xs font-medium text-muted-foreground">Who answers here</div>
        <ModelPicker area={area} fill agentsOnly={agentsOnly} onPicked={onPicked} className="flex-col items-stretch [&>*]:flex-none" />
        <PromptButton area={area} className="w-full justify-start" />
      </PopoverContent>
    </Popover>
  )
}
