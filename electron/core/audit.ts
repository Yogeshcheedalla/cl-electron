import { bus } from './bus'
import { activity } from '../db/log.repo'
import type { ActivityEntry } from '../../shared/records'

/**
 * Writes an activity row and pushes it to the UI in one step, so the timeline
 * stays live without polling. Everything Akansha does on the user's behalf goes
 * through here -- it is the audit trail the Activity screen reads.
 */
export function audit(entry: Omit<ActivityEntry, 'id' | 'ts'>): ActivityEntry {
  const row = activity.add(entry)
  bus.emitToUi({ type: 'activity', entry: row })
  return row
}
