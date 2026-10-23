import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

function useAppTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "light" ? "light" : "dark")
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(read()))
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => watch.disconnect()
  }, [])
  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  // Our theme switches with data-theme on <html> (see applyTheme in lib/store.ts), not next-themes.
  const theme = useAppTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
