/**
 * The `projects` table. `total_hours` is decimal hours on disk and `Project.totalMinutes`
 * an integer above it; `mapProjectRow` converts, so nothing here hands out a raw row.
 *
 * The default listing order is creation order rather than name: `created_at` is the
 * tie-breaker the engine uses when two blocks share a rank.
 */

import { getDb, type Db } from '../db';
import { hoursToMinutes, minutesToHours } from '../dates';
import { mapProjectRow, type Project, type ProjectRow } from '../../types';
import { prepared } from './statements';

const COLUMNS = 'id, name, description, color, total_hours, created_at, updated_at';

/** What a POST /api/projects supplies. The id and the timestamps are ours. */
export interface NewProject {
  id: string;
  name: string;
  description?: string;
  color: string;
  totalMinutes: number;
}

/** A metadata edit. `undefined` means "leave this column alone". */
export interface ProjectPatch {
  name?: string;
  description?: string | null;
  color?: string;
  totalMinutes?: number;
}

export function listProjects(db: Db = getDb()): Project[] {
  const rows = prepared<ProjectRow>(db, `SELECT ${COLUMNS} FROM projects ORDER BY created_at, id`).all();
  return rows.map(mapProjectRow);
}

/** Just enough of a job to draw one of its blocks: the label and the swatch. */
export interface ProjectLabel {
  id: string;
  name: string;
  color: string;
}

/** Every job's label and colour — what the week view joins onto its blocks. */
export function listProjectLabels(db: Db = getDb()): ProjectLabel[] {
  return prepared<ProjectLabel>(db, 'SELECT id, name, color FROM projects').all();
}

export function findProject(id: string, db: Db = getDb()): Project | undefined {
  const row = prepared<ProjectRow>(db, `SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id);
  return row === undefined ? undefined : mapProjectRow(row);
}

/** Inserts and returns the stored row, so the caller sees SQLite's timestamps. */
export function insertProject(project: NewProject, db: Db = getDb()): Project {
  prepared(
    db,
    `INSERT INTO projects (id, name, description, color, total_hours)
     VALUES (@id, @name, @description, @color, @total_hours)`,
  ).run({
    id: project.id,
    name: project.name,
    description: project.description ?? null,
    color: project.color,
    total_hours: minutesToHours(project.totalMinutes),
  });
  return requireStored(project.id, db);
}

/**
 * Applies only the keys present in `patch`; `undefined` when the row is gone, so a route
 * can answer 404 without a second SELECT. `updated_at` is left to the table's trigger,
 * which only fires because this UPDATE does not mention the column.
 */
export function updateProject(id: string, patch: ProjectPatch, db: Db = getDb()): Project | undefined {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.name !== undefined) {
    assignments.push('name = @name');
    params.name = patch.name;
  }
  if (patch.description !== undefined) {
    assignments.push('description = @description');
    params.description = patch.description;
  }
  if (patch.color !== undefined) {
    assignments.push('color = @color');
    params.color = patch.color;
  }
  if (patch.totalMinutes !== undefined) {
    assignments.push('total_hours = @total_hours');
    params.total_hours = minutesToHours(patch.totalMinutes);
  }

  if (assignments.length === 0) return findProject(id, db);

  const result = prepared(db, `UPDATE projects SET ${assignments.join(', ')} WHERE id = @id`).run(params);
  return result.changes === 0 ? undefined : requireStored(id, db);
}

/** True when a row was actually removed. Blocks go with it, by ON DELETE CASCADE. */
export function deleteProject(id: string, db: Db = getDb()): boolean {
  return prepared(db, 'DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

/**
 * Every project's estimate in integer minutes, one half of the invariant the scheduler
 * asserts. Each row is converted on its own to keep the comparison exact: summing decimal
 * hours in SQL and converting once would let 0.1 h drift into the total.
 */
export function totalMinutesByProject(db: Db = getDb()): Map<string, number> {
  const rows = prepared<{ id: string; total_hours: number }>(
    db,
    'SELECT id, total_hours FROM projects',
  ).all();
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.id, hoursToMinutes(row.total_hours));
  return totals;
}

function requireStored(id: string, db: Db): Project {
  const project = findProject(id, db);
  if (project === undefined) {
    // Only reachable if the row vanished between two statements of one transaction.
    throw new Error(`Project "${id}" disappeared while being written`);
  }
  return project;
}
