// Drawn icons in one stroke weight; they are decoration, so each is hidden from assistive technology.
const paths = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  up: <path d="M12 19V6M6.5 11.5L12 6l5.5 5.5" />,
  down: <path d="M12 5v13M6.5 12.5L12 18l5.5-5.5" />,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.01" /></>,
  cross: <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>,
}
export type IconName = keyof typeof paths

export function Icon({ name }: { name: IconName }) {
  return <svg className="i" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}
