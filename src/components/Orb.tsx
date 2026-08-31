/** Six visual states, driven only by what the main process reports. */
export function Orb({ state, size = 84 }: { state: string; size?: number }) {
  const core = Math.round(size * 0.38)
  return (
    <div
      className="orb"
      data-state={state}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Assistant state: ${state.toLowerCase()}`}
    >
      <span className="ring" />
      <span className="core" style={{ width: core, height: core }} />
    </div>
  )
}

export const STATE_TEXT: Record<string, string> = {
  IDLE: 'Idle',
  LISTENING: 'Listening',
  THINKING: 'Thinking',
  SPEAKING: 'Speaking',
  EXECUTING: 'Running a tool',
  ERROR: 'Last action failed'
}
