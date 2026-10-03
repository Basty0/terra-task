const statusOrder = ['to_analyze', 'todo', 'in_progress', 'done', 'abandoned']
const statusLabels = { to_analyze: 'À analyser', todo: 'À faire', in_progress: 'En cours', done: 'Terminé', abandoned: 'Abandonné' }
const statusDescriptions = { to_analyze: 'Briefs à décortiquer', todo: 'Prêtes à démarrer', in_progress: 'En train de bouger', done: 'Livrées avec fierté', abandoned: 'Mises de côté' }
const state = { board: null, search: '', member: '', difficulty: '', loading: false }
const dialog = document.querySelector('#task-dialog')

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const initials = (name) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
const formatNumber = (value) => new Intl.NumberFormat('fr-FR').format(value || 0)
const formatTime = (date) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(date)
const difficultyClass = (difficulty) => ({ Facile: 'easy', Moyenne: 'medium', Difficile: 'hard', Expert: 'expert' }[difficulty] || 'medium')

async function loadBoard({ quiet = true, sync = false } = {}) {
  if (state.loading) return
  state.loading = true
  if (!quiet) document.querySelector('#sync-button').classList.add('is-loading')
  renderLoadingSkeleton()
  try {
    const response = await fetch(sync ? '/api/sync' : '/api/board', {
      method: sync ? 'POST' : 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('Le serveur ne répond pas.')
    state.board = await response.json()
    render()
  } catch (error) {
    if (state.board) {
      render()
    } else {
      renderUnavailableBoard()
    }
    document.querySelector('#connection-label').textContent = 'Serveur indisponible'
    document.querySelector('.live-dot').classList.add('live-dot-error')
    document.querySelector('#error-notice').hidden = false
    document.querySelector('#error-message').textContent = error.message
  } finally {
    state.loading = false
    document.querySelector('#sync-button').classList.remove('is-loading')
  }
}

function renderLoadingSkeleton() {
  document.querySelectorAll('#stat-total, #stat-progress, #stat-done, #stat-xp-done, #stat-xp-available').forEach((element) => {
    element.innerHTML = '<span class="skeleton skeleton-stat" aria-hidden="true"></span>'
  })
  document.querySelector('#team-grid').innerHTML = Array.from({ length: 3 }, () => '<div class="member-card skeleton-card" aria-hidden="true"><span class="skeleton skeleton-avatar"></span><span class="skeleton-copy"><i class="skeleton skeleton-line"></i><i class="skeleton skeleton-line skeleton-line-short"></i></span><span class="skeleton skeleton-xp"></span></div>').join('')
  document.querySelector('#kanban').innerHTML = statusOrder.map((status) => `
    <section class="kanban-column column-${status}" aria-hidden="true">
      <div class="skeleton-column-heading"><i class="skeleton skeleton-number"></i><i class="skeleton skeleton-line"></i></div>
      <div class="column-cards">${Array.from({ length: 2 }, () => '<div class="task-card skeleton-card"><i class="skeleton skeleton-line skeleton-line-short"></i><i class="skeleton skeleton-line"></i><i class="skeleton skeleton-line skeleton-line-medium"></i></div>').join('')}</div>
    </section>`).join('')
  document.querySelector('#team-grid').setAttribute('aria-busy', 'true')
  document.querySelector('#kanban').setAttribute('aria-busy', 'true')
}

function renderUnavailableBoard() {
  document.querySelectorAll('#stat-total, #stat-progress, #stat-done, #stat-xp-done, #stat-xp-available').forEach((element) => {
    element.textContent = '—'
  })
  document.querySelector('#team-grid').innerHTML = ''
  document.querySelector('#kanban').innerHTML = '<div class="board-unavailable">Les demandes ne sont pas disponibles pour le moment.</div>'
  document.querySelector('#team-grid').setAttribute('aria-busy', 'false')
  document.querySelector('#kanban').setAttribute('aria-busy', 'false')
}

function render() {
  const board = state.board
  if (!board) return
  const isConnected = board.api_configured && !board.sync_error
  document.querySelector('#connection-label').textContent = isConnected ? 'Terra Nova connecté' : board.api_configured ? 'Flux à vérifier' : 'API à configurer'
  document.querySelector('.live-dot').classList.toggle('live-dot-error', !isConnected)
  document.querySelector('#stat-total').textContent = formatNumber(board.stats.total)
  document.querySelector('#stat-progress').textContent = formatNumber(board.stats.in_progress)
  document.querySelector('#stat-done').textContent = formatNumber(board.stats.done)
  document.querySelector('#stat-xp-done').textContent = `${formatNumber(board.stats.xp_done)} XP`
  document.querySelector('#stat-xp-available').textContent = formatNumber(board.stats.xp_available)
  document.querySelector('#board-count').textContent = formatNumber(board.stats.total)
  document.querySelector('#team-count').textContent = String(board.members.length).padStart(2, '0')

  const minutes = Number(board.session?.minutes_until_next_wave || 0)
  const nextWave = Number(board.session?.next_wave_number || 0)
  document.querySelector('#next-wave').textContent = nextWave ? `${minutes} min` : board.session?.is_running ? 'Dernière vague' : 'En attente'
  document.querySelector('#wave-meta').textContent = nextWave ? `Vague ${nextWave} · ${board.session.visible_requests_count || 0} demandes visibles` : board.session?.status === 'none' ? 'Les infos arriveront depuis l’API' : `${board.session.visible_requests_count || 0} demandes visibles`

  const syncError = board.sync_error
  document.querySelector('#setup-notice').hidden = board.api_configured || board.stats.total > 0
  document.querySelector('#error-notice').hidden = !syncError || !board.api_configured
  if (syncError && board.api_configured) document.querySelector('#error-message').textContent = syncError
  document.querySelector('#last-sync').textContent = board.last_synced_at ? `Dernière synchro à ${formatTime(new Date(board.last_synced_at))}` : 'En attente de la première synchronisation'

  renderMembers(board)
  renderBoard(board)
  document.querySelector('#team-grid').setAttribute('aria-busy', 'false')
  document.querySelector('#kanban').setAttribute('aria-busy', 'false')
}

function renderMembers(board) {
  const teamGrid = document.querySelector('#team-grid')
  teamGrid.innerHTML = board.team.map((member, index) => `
    <button class="member-card member-${index + 1} ${state.member === member.name ? 'member-card-selected' : ''}" type="button" data-member="${escapeHtml(member.name)}" aria-pressed="${state.member === member.name}">
      <div class="member-avatar">${escapeHtml(initials(member.name))}<i></i></div>
      <div class="member-info"><strong>${escapeHtml(member.name)}</strong><span>${member.task_count} tâche${member.task_count > 1 ? 's' : ''} assignée${member.task_count > 1 ? 's' : ''}</span><div class="member-meta"><span>${member.in_progress_count} en cours</span><span>${member.done_count} livrée${member.done_count > 1 ? 's' : ''}</span></div></div>
      <div class="member-xp"><strong>${formatNumber(member.xp)}</strong><span>XP gagnés</span></div>
    </button>`).join('')
  teamGrid.querySelectorAll('[data-member]').forEach((card) => card.addEventListener('click', () => {
    state.member = state.member === card.dataset.member ? '' : card.dataset.member
    document.querySelector('#member-filter').value = state.member
    renderMembers(state.board)
    renderBoard(state.board)
  }))
  const filter = document.querySelector('#member-filter')
  const selection = filter.value
  filter.innerHTML = '<option value="">Toute l’équipe</option>' + board.members.map((member) => `<option value="${escapeHtml(member.name)}">${escapeHtml(member.name)}</option>`).join('')
  filter.value = selection
}

function filteredTasks(board) {
  const query = state.search.toLocaleLowerCase('fr')
  return board.tasks.filter((task) => {
    const matchesSearch = !query || `${task.request_code} ${task.message_public} ${task.requester_name}`.toLocaleLowerCase('fr').includes(query)
    return matchesSearch && (!state.member || task.assigned_to === state.member) && (!state.difficulty || task.difficulty === state.difficulty)
  })
}

function renderBoard(board) {
  const tasks = filteredTasks(board)
  const columns = document.querySelector('#kanban')
  columns.innerHTML = statusOrder.map((status, index) => {
    const statusTasks = tasks.filter((task) => task.status === status)
    return `
      <section class="kanban-column column-${status}" aria-labelledby="column-${status}">
        <header class="column-header"><div class="column-title"><span class="column-number">0${index + 1}</span><div><h3 id="column-${status}">${statusLabels[status]}</h3><p>${statusDescriptions[status]}</p></div></div><span class="column-count">${statusTasks.length}</span></header>
        <div class="column-cards">${statusTasks.length ? statusTasks.map(taskCard).join('') : `<div class="column-empty"><span>✳</span><p>${board.tasks.length ? 'Rien à afficher ici.' : 'La prochaine demande attend l’API.'}</p></div>`}</div>
      </section>`
  }).join('')
  columns.querySelectorAll('[data-task-code]').forEach((card) => card.addEventListener('click', () => openTask(card.dataset.taskCode)))
}

function taskCard(task) {
  const member = task.assigned_to ? `<span class="card-owner"><span class="mini-avatar">${escapeHtml(initials(task.assigned_to))}</span>${escapeHtml(task.assigned_to)}</span>` : '<span class="card-owner unassigned">À assigner</span>'
  const priority = task.priority ? `<span class="priority-mark" aria-label="Priorité ${task.priority}">${'★'.repeat(task.priority)}</span>` : ''
  const link = task.feature_url ? '<span class="card-link" title="Lien de la fonctionnalité">↗</span>' : ''
  const branch = task.branch_name ? `<div class="branch-row"><span class="branch-glyph">⑂</span><span class="branch-name" title="${escapeHtml(task.branch_name)}">${escapeHtml(task.branch_name)}</span></div>` : ''
  return `<button class="task-card" data-task-code="${escapeHtml(task.request_code)}" type="button">
    <div class="card-top"><span class="card-code">${escapeHtml(task.request_code)}</span><span class="difficulty-pill ${difficultyClass(task.difficulty)}">${escapeHtml(task.difficulty || 'Moyenne')}</span></div>
    <strong class="card-title">${escapeHtml(task.message_public || 'Demande Terra Nova')}</strong>
    <div class="card-bottom"><div class="card-tags">${task.is_new ? '<span class="new-tag"><i></i>NOUVEAU</span>' : ''}${priority}</div><span class="xp-badge">${formatNumber(task.xp_available)} <small>XP</small></span></div>
    <div class="progress-row"><div class="progress-track"><span style="width:${Math.max(0, Math.min(100, task.progress))}%"></span></div><b>${task.progress}%</b></div>
    ${branch}
    <div class="card-footer">${member}<span class="card-footer-end">${link}<span class="wave-tag">${task.is_initial ? 'Initiale' : `Vague ${task.wave_number || '—'}`}</span></span></div>
  </button>`
}

function openTask(code) {
  const task = state.board.tasks.find((entry) => entry.request_code === code)
  if (!task) return
  document.querySelector('#dialog-code').textContent = task.request_code
  const difficulty = document.querySelector('#dialog-difficulty')
  difficulty.textContent = task.difficulty || 'Moyenne'
  difficulty.className = `difficulty-pill ${difficultyClass(task.difficulty)}`
  document.querySelector('#dialog-group').textContent = task.group_name || 'Terra Nova'
  const safeFeatureUrl = task.feature_url && (/^https?:\/\//i.test(task.feature_url) || task.feature_url.startsWith('/')) ? task.feature_url : ''
  const arrivalLabel = task.is_initial ? 'Demande initiale' : `Vague ${task.visible_since_wave || task.wave_number || '—'}`
  const aiLabel = task.is_ai_request ? 'Demande liée à l’IA' : task.is_ai_related ? 'Sujet lié à l’IA' : 'Demande standard'
  const arrivalTime = task.arrival_time ? `H+${task.arrival_time}` : 'Au lancement'
  document.querySelector('#dialog-content').innerHTML = `
    <div class="detail-origin"><div class="requester-avatar">${escapeHtml(initials(task.requester_name || 'TN'))}</div><div class="requester-copy"><span>DEMANDE TRANSMISE PAR</span><strong>${escapeHtml(task.requester_name || 'Terra Nova')}</strong><small>${escapeHtml(task.requester_type || 'Institution')}</small></div><span class="origin-group">${escapeHtml(task.group_name || 'Terra Nova')}</span></div>
    <div class="detail-title-row"><div><span class="detail-eyebrow">BESOIN EXPRIMÉ</span><h2>La demande</h2></div><span class="ai-indicator ${task.is_ai_related || task.is_ai_request ? 'ai-indicator-active' : ''}"><span></span>${escapeHtml(aiLabel)}</span></div>
    <blockquote class="request-message">${escapeHtml(task.message_public || 'Aucun détail fourni.')}</blockquote>
    <div class="detail-xp-panel"><div class="xp-total-card"><span>XP TOTAL</span><strong>${formatNumber(task.xp_total)}<small>XP</small></strong><i>${formatNumber(task.xp_available)} XP disponibles selon l’API</i></div><div class="xp-breakdown"><div><span>XP DE BASE</span><strong>${formatNumber(task.xp_base)} <small>XP</small></strong></div><div><span>BONUS FIXE</span><strong>+${formatNumber(task.xp_time_bonus)} <small>XP</small></strong></div></div></div>
    <div class="detail-meta-grid"><div class="detail-meta-item"><span class="meta-icon meta-difficulty">◈</span><div><small>DIFFICULTÉ</small><strong>${escapeHtml(task.difficulty || 'Non précisée')} <i>Niveau ${task.difficulty_level || 1}</i></strong></div></div><div class="detail-meta-item"><span class="meta-icon meta-wave">⌁</span><div><small>APPARITION</small><strong>${escapeHtml(arrivalLabel)}</strong><em>${escapeHtml(arrivalTime)}</em></div></div></div>
    <section class="tracking-section"><div class="tracking-heading"><span class="tracking-icon">↗</span><div><h3>Suivi de l’équipe</h3><p>Les infos internes de Faly, Stephano et Djaffar.</p></div></div><form id="task-form" class="task-form">
      <div class="form-row"><label>Assigné à<select name="assigned_to"><option value="">Personne pour l’instant</option>${state.board.members.map((name) => `<option value="${escapeHtml(name)}" ${task.assigned_to === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label><label>Statut<select name="status">${statusOrder.map((status) => `<option value="${status}" ${task.status === status ? 'selected' : ''}>${statusLabels[status]}</option>`).join('')}</select></label></div>
      <div class="form-row"><label>Progression<select name="progress">${[0, 25, 50, 75, 100].map((value) => `<option value="${value}" ${task.progress === value ? 'selected' : ''}>${value} %</option>`).join('')}</select></label><label>Priorité<select name="priority"><option value="0" ${task.priority === 0 ? 'selected' : ''}>Sans priorité</option><option value="1" ${task.priority === 1 ? 'selected' : ''}>★ À regarder</option><option value="2" ${task.priority === 2 ? 'selected' : ''}>★★ Importante</option><option value="3" ${task.priority === 3 ? 'selected' : ''}>★★★ Prioritaire</option></select></label></div>
      <label>Branche Git<input name="branch_name" type="text" maxlength="200" value="${escapeHtml(task.branch_name)}" placeholder="feature/nom-de-la-tache" autocomplete="off" spellcheck="false" /><small class="field-hint">Collez le nom de la branche liée à cette tâche.</small></label>
      <label>Note d’équipe<textarea name="team_note" rows="3" maxlength="2000" placeholder="Une info utile pour les autres…">${escapeHtml(task.team_note)}</textarea></label>
      <label>Lien de la fonctionnalité<input name="feature_url" type="text" maxlength="300" value="${escapeHtml(task.feature_url)}" placeholder="/services/… ou https://…" /></label>
      ${safeFeatureUrl ? `<a class="feature-link" href="${escapeHtml(safeFeatureUrl)}" target="_blank" rel="noreferrer">Ouvrir la fonctionnalité ↗</a>` : ''}
      <div class="form-error" id="form-error" role="alert"></div>
      <button class="button button-save" type="submit"><span>Enregistrer les changements</span><span>↗</span></button>
    </form></section>`

  document.querySelector('#task-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const payload = {
      assigned_to: form.get('assigned_to') || null,
      status: form.get('status'),
      progress: Number(form.get('progress')),
      priority: Number(form.get('priority')),
      team_note: form.get('team_note'),
      feature_url: form.get('feature_url'),
      branch_name: form.get('branch_name'),
    }
    const button = event.currentTarget.querySelector('button[type="submit"]')
    button.disabled = true
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Impossible d’enregistrer les changements.')
      dialog.close()
      await loadBoard()
    } catch (error) {
      document.querySelector('#form-error').textContent = error.message
    } finally {
      button.disabled = false
    }
  })
  dialog.showModal()
}

document.querySelector('#search-input').addEventListener('input', (event) => { state.search = event.target.value; if (state.board) renderBoard(state.board) })
document.querySelector('#member-filter').addEventListener('change', (event) => {
  state.member = event.target.value
  if (state.board) {
    renderMembers(state.board)
    renderBoard(state.board)
  }
})
document.querySelector('#difficulty-filter').addEventListener('change', (event) => { state.difficulty = event.target.value; if (state.board) renderBoard(state.board) })
document.querySelector('#sync-button').addEventListener('click', async () => {
  await loadBoard({ quiet: false, sync: true })
})

void loadBoard({ quiet: false })
window.setInterval(() => void loadBoard(), 15 * 60_000)
