import type { ReactNode } from 'react'

// An on/off setting. It is a real checkbox with the switch role, so the keyboard and screen readers treat it as a switch.
export function Toggle({ checked, onChange, children, disabled = false }: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return <label className="switch"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{children}</label>
}
