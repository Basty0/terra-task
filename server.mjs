import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadEnvFile } from 'node:process'

const root = fileURLToPath(new URL('.', import.meta.url))
const publicDirectory = join(root, 'public')
const dataDirectory = join(root, 'data')
const databasePath = join(dataDirectory, 'terra-task.sqlite')
const apiUrl = 'https://24h.webcup.fr/wp-json/webcup/v1/requests'
const members = ['Faly', 'Stephano', 'Djaffar']
const statuses = ['to_analyze', 'todo', 'in_progress', 'done', 'abandoned']
const statusLabels = {
  to_analyze: 'À analyser',
  todo: 'À faire',
  in_progress: 'En cours',
  done: 'Terminé',
  abandoned: 'Abandonné',
}
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

try {
  loadEnvFile(join(root, '.env'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

mkdirSync(dataDirectory, { recursive: true })
const database = new DatabaseSync(databasePath)
database.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    request_code TEXT PRIMARY KEY,
    requester_name TEXT NOT NULL DEFAULT '',
    requester_type TEXT NOT NULL DEFAULT '',
    message_public TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT '',
    difficulty_level INTEGER NOT NULL DEFAULT 1,
    group_name TEXT NOT NULL DEFAULT '',
    visible_since_wave INTEGER NOT NULL DEFAULT 0,
    is_ai_related INTEGER NOT NULL DEFAULT 0,
    is_ai_request INTEGER NOT NULL DEFAULT 0,
    xp_base INTEGER NOT NULL DEFAULT 0,
    xp_time_bonus INTEGER NOT NULL DEFAULT 0,
    xp_total INTEGER NOT NULL DEFAULT 0,
    xp_available INTEGER NOT NULL DEFAULT 0,
    is_initial INTEGER NOT NULL DEFAULT 0,
    arrival_type TEXT NOT NULL DEFAULT '',
    wave_number INTEGER NOT NULL DEFAULT 0,
    arrival_time TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'to_analyze',
    assigned_to TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    team_note TEXT NOT NULL DEFAULT '',
    feature_url TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`)
const taskColumns = database.prepare('PRAGMA table_info(tasks)').all()
if (!taskColumns.some((column) => column.name === 'branch_name')) {
  database.exec("ALTER TABLE tasks ADD COLUMN branch_name TEXT NOT NULL DEFAULT ''")
}
for (const [columnName, sqlType] of [
  ['group_name', "TEXT NOT NULL DEFAULT ''"],
  ['visible_since_wave', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_ai_related', 'INTEGER NOT NULL DEFAULT 0'],
  ['is_ai_request', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  if (!taskColumns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE tasks ADD COLUMN ${columnName} ${sqlType}`)
  }
}

const findTasks = database.prepare('SELECT * FROM tasks ORDER BY xp_available DESC, request_code ASC')
const findTask = database.prepare('SELECT * FROM tasks WHERE request_code = ?')
const insertTask = database.prepare(`
  INSERT INTO tasks (
    request_code, requester_name, requester_type, message_public, difficulty,
    difficulty_level, group_name, visible_since_wave, is_ai_related, is_ai_request,
    xp_base, xp_time_bonus, xp_total, xp_available, is_initial, arrival_type,
    wave_number, arrival_time, first_seen_at, updated_at
  ) VALUES (
    @request_code, @requester_name, @requester_type, @message_public, @difficulty,
    @difficulty_level, @group_name, @visible_since_wave, @is_ai_related, @is_ai_request,
    @xp_base, @xp_time_bonus, @xp_total, @xp_available, @is_initial, @arrival_type,
    @wave_number, @arrival_time, @now, @now
  )
`)
const updateRemoteTask = database.prepare(`
  UPDATE tasks SET
    requester_name = @requester_name,
    requester_type = @requester_type,
    message_public = @message_public,
    difficulty = @difficulty,
    difficulty_level = @difficulty_level,
    group_name = @group_name,
    visible_since_wave = @visible_since_wave,
    is_ai_related = @is_ai_related,
    is_ai_request = @is_ai_request,
    xp_base = @xp_base,
    xp_time_bonus = @xp_time_bonus,
    xp_total = @xp_total,
    xp_available = @xp_available,
    is_initial = @is_initial,
    arrival_type = @arrival_type,
    wave_number = @wave_number,
    arrival_time = @arrival_time,
    updated_at = @now
  WHERE request_code = @request_code
`)

let session = { status: 'none', is_running: false, current_wave: 0, visible_requests_count: 0, next_wave_number: 0, minutes_until_next_wave: 0 }
let syncError = ''
let lastSyncedAt = ''
let syncInProgress = false

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) ? number : fallback
}

function remoteTask(request) {
  const code = String(request.request_code ?? '').trim().slice(0, 32)
  if (!code) return null

  const xpBase = safeInteger(request.xp_base)
  const bonus = safeInteger(request.xp_time_bonus)
  const total = safeInteger(request.xp_total, xpBase + bonus)

  return {
    request_code: code,
    requester_name: String(request.requester_name ?? '').slice(0, 160),
    requester_type: String(request.requester_type ?? '').slice(0, 100),
    message_public: String(request.message_public ?? '').slice(0, 12000),
    difficulty: String(request.difficulty ?? '').slice(0, 80),
    difficulty_level: Math.min(4, Math.max(1, safeInteger(request.difficulty_level, 1))),
    group_name: String(request.group_name ?? '').slice(0, 120),
    visible_since_wave: safeInteger(request.visible_since_wave),
    is_ai_related: request.is_ai_related === true || request.is_ai_related === 1 ? 1 : 0,
    is_ai_request: request.is_ai_request === true || request.is_ai_request === 1 ? 1 : 0,
    xp_base: xpBase,
    xp_time_bonus: bonus,
    xp_total: total,
    xp_available: safeInteger(request.xp_available, total),
    is_initial: request.is_initial === true ? 1 : 0,
    arrival_type: String(request.arrival_type ?? '').slice(0, 40),
    wave_number: safeInteger(request.wave_number),
    arrival_time: String(request.arrival_time ?? '').slice(0, 30),
  }
}

async function syncRequests() {
  if (syncInProgress) return
  const apiKey = process.env.WEBCUP_API_KEY?.trim()
  if (!apiKey) {
    syncError = 'Ajoutez WEBCUP_API_KEY dans le fichier .env pour connecter le flux Terra Nova.'
    return
  }

  syncInProgress = true
  try {
    const response = await fetch(apiUrl, {
      headers: { 'X-Webcup-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`L’API Terra Nova répond avec le code ${response.status}.`)

    const payload = await response.json()
    if (!Array.isArray(payload.requests)) throw new Error('La réponse de l’API ne contient pas de liste de demandes valide.')

    const now = new Date().toISOString()
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const rawRequest of payload.requests) {
        const request = remoteTask(rawRequest)
        if (!request) continue
        if (findTask.get(request.request_code)) {
          updateRemoteTask.run({ ...request, now })
        } else {
          insertTask.run({ ...request, now })
        }
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    session = payload.session ?? session
    syncError = ''
    lastSyncedAt = now
  } catch (error) {
    syncError = error instanceof Error ? error.message : 'La synchronisation Terra Nova a échoué.'
  } finally {
    syncInProgress = false
  }
}

function getBoard() {
  const tasks = findTasks.all().map((task) => ({
    ...task,
    is_initial: Boolean(task.is_initial),
    is_new: Date.now() - Date.parse(task.first_seen_at) < 5 * 60 * 1000,
  }))
  const team = members.map((name) => {
    const assignedTasks = tasks.filter((task) => task.assigned_to === name)
    return {
      name,
      task_count: assignedTasks.length,
      in_progress_count: assignedTasks.filter((task) => task.status === 'in_progress').length,
      done_count: assignedTasks.filter((task) => task.status === 'done').length,
      xp: assignedTasks.filter((task) => task.status === 'done').reduce((sum, task) => sum + task.xp_available, 0),
    }
  })

  return {
    tasks,
    members,
    statuses: statusLabels,
    session,
    sync_error: syncError,
    last_synced_at: lastSyncedAt,
    api_configured: Boolean(process.env.WEBCUP_API_KEY?.trim()),
    stats: {
      total: tasks.length,
      in_progress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length,
      xp_done: tasks.filter((task) => task.status === 'done').reduce((sum, task) => sum + task.xp_available, 0),
      xp_active: tasks.filter((task) => task.status === 'in_progress').reduce((sum, task) => sum + task.xp_available, 0),
      xp_available: tasks.filter((task) => task.status !== 'done' && task.status !== 'abandoned').reduce((sum, task) => sum + task.xp_available, 0),
    },
    team,
  }
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 24_000) throw new Error('Le contenu envoyé est trop volumineux.')
  }
  return body ? JSON.parse(body) : {}
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(data))
}

function requestHasTrustedOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  const pathname = new URL(request.url, 'http://localhost').pathname
  if (request.method === 'GET' && pathname === '/api/board') {
    await syncRequests()
    sendJson(response, 200, getBoard())
    return
  }

  if (request.method === 'POST' && pathname === '/api/sync') {
    if (!requestHasTrustedOrigin(request)) {
      sendJson(response, 403, { error: 'Origine non autorisée.' })
      return
    }
    await syncRequests()
    sendJson(response, syncError && process.env.WEBCUP_API_KEY ? 502 : 200, getBoard())
    return
  }

  if (request.method === 'PATCH' && pathname.startsWith('/api/tasks/')) {
    if (!requestHasTrustedOrigin(request)) {
      sendJson(response, 403, { error: 'Origine non autorisée.' })
      return
    }
    const requestCode = decodeURIComponent(pathname.slice('/api/tasks/'.length))
    const task = findTask.get(requestCode)
    if (!task) {
      sendJson(response, 404, { error: 'Demande introuvable.' })
      return
    }

    let updates
    try {
      updates = await readJson(request)
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'JSON invalide.' })
      return
    }

    const allowedKeys = ['assigned_to', 'status', 'progress', 'priority', 'team_note', 'feature_url', 'branch_name']
    if (Object.keys(updates).some((key) => !allowedKeys.includes(key))) {
      sendJson(response, 422, { error: 'Certains champs ne peuvent pas être modifiés.' })
      return
    }
    if (updates.assigned_to !== undefined && updates.assigned_to !== null && !members.includes(updates.assigned_to)) {
      sendJson(response, 422, { error: 'Choisissez un membre de l’équipe.' })
      return
    }
    if (updates.status !== undefined && !statuses.includes(updates.status)) {
      sendJson(response, 422, { error: 'Choisissez un statut valide.' })
      return
    }
    if (updates.progress !== undefined && (!Number.isInteger(updates.progress) || updates.progress < 0 || updates.progress > 100 || updates.progress % 25 !== 0)) {
      sendJson(response, 422, { error: 'La progression doit être comprise entre 0 et 100 %, par pas de 25 %.' })
      return
    }
    if (updates.priority !== undefined && (!Number.isInteger(updates.priority) || updates.priority < 0 || updates.priority > 3)) {
      sendJson(response, 422, { error: 'La priorité doit être comprise entre 0 et 3.' })
      return
    }
    if (updates.team_note !== undefined && (typeof updates.team_note !== 'string' || updates.team_note.length > 2000)) {
      sendJson(response, 422, { error: 'La note est limitée à 2 000 caractères.' })
      return
    }
    if (updates.feature_url !== undefined && (typeof updates.feature_url !== 'string' || updates.feature_url.length > 300)) {
      sendJson(response, 422, { error: 'Le lien est limité à 300 caractères.' })
      return
    }
    if (updates.branch_name !== undefined && (typeof updates.branch_name !== 'string' || updates.branch_name.length > 200)) {
      sendJson(response, 422, { error: 'Le nom de branche est limité à 200 caractères.' })
      return
    }

    const values = Object.fromEntries(allowedKeys.map((key) => [key, updates[key] ?? task[key]]))
    if (values.status === 'done') values.progress = 100
    const updateSql = allowedKeys.map((key) => `${key} = @${key}`).join(', ')
    database.prepare(`UPDATE tasks SET ${updateSql}, updated_at = @updated_at WHERE request_code = @request_code`).run({
      ...values,
      updated_at: new Date().toISOString(),
      request_code: requestCode,
    })
    sendJson(response, 200, { task: findTask.get(requestCode) })
    return
  }

  const decodedPath = decodeURIComponent(pathname)
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath
  const filePath = resolve(publicDirectory, `.${requestedPath}`)
  const relativePath = relative(publicDirectory, filePath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Page introuvable')
    return
  }
  response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(response)
})

const port = Number(process.env.PORT || 4173)
server.listen(port, '0.0.0.0', () => {
  console.log(`Terra Task est disponible sur http://localhost:${port}`)
  void syncRequests()
})

setInterval(() => void syncRequests(), 15 * 60_000).unref()
