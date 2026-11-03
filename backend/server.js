import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const databasePath = path.join(here, 'data', 'lifeos.json');
const openStatuses = new Set(['todo', 'to do', 'in progress', 'in review', 'blocked']);

async function readDatabase() {
  return JSON.parse(await fs.readFile(databasePath, 'utf8'));
}

async function writeDatabase(data) {
  const tempPath = `${databasePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, databasePath);
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Request body is too large.');
  }
  return body ? JSON.parse(body) : {};
}

function createReviews(data, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 7);
  const reviews = [];
  const add = (review) => reviews.push({ id: crypto.randomUUID(), createdAt: now.toISOString(), dismissed: false, ...review });

  for (const task of data.tasks) {
    if (!openStatuses.has(String(task.status).toLowerCase())) continue;
    const due = task.dueDate ? new Date(`${task.dueDate}T00:00:00`) : null;
    if (!due || Number.isNaN(due.getTime())) continue;
    if (due < today) {
      add({ type: 'overdue-task', severity: task.priority === 'High' ? 'high' : 'medium', title: `Task overdue: ${task.title}`, detail: `Due ${task.dueDate}${task.projectId ? ` · ${data.projects.find((p) => p.id === task.projectId)?.name || 'Project'}` : ''}.`, entityType: 'task', entityId: task.id, projectId: task.projectId, suggestedAction: 'Review the task and set a new due date or mark it complete.' });
    } else if (due <= soon) {
      add({ type: 'due-soon-task', severity: 'medium', title: `Due soon: ${task.title}`, detail: `Due ${task.dueDate}${task.projectId ? ` · ${data.projects.find((p) => p.id === task.projectId)?.name || 'Project'}` : ''}.`, entityType: 'task', entityId: task.id, projectId: task.projectId, suggestedAction: 'Confirm the next step and make time for it.' });
    }
  }

  for (const project of data.projects) {
    if (project.status === 'completed') continue;
    const lastUpdated = new Date(project.updatedAt);
    const ageDays = Number.isNaN(lastUpdated.getTime()) ? null : Math.floor((today - lastUpdated) / 86_400_000);
    const overdueCount = data.tasks.filter((task) => task.projectId === project.id && openStatuses.has(String(task.status).toLowerCase()) && task.dueDate && new Date(`${task.dueDate}T00:00:00`) < today).length;
    if (ageDays !== null && ageDays >= 7) {
      add({ type: 'stale-project', severity: overdueCount ? 'high' : 'low', title: `Project needs an update: ${project.name}`, detail: `No update recorded for ${ageDays} days${overdueCount ? ` · ${overdueCount} open overdue task${overdueCount === 1 ? '' : 's'}` : ''}.`, entityType: 'project', entityId: project.id, projectId: project.id, suggestedAction: 'Add a progress update and choose the next milestone.' });
    } else if (overdueCount >= 2) {
      add({ type: 'project-task-risk', severity: 'high', title: `Several overdue tasks: ${project.name}`, detail: `${overdueCount} open tasks are past their due dates.`, entityType: 'project', entityId: project.id, projectId: project.id, suggestedAction: 'Review blockers and re-plan the project workload.' });
    }
  }

  for (const goal of data.goals) {
    if (goal.progress >= 100 || !goal.dueDate) continue;
    const due = new Date(`${goal.dueDate}T00:00:00`);
    if (!Number.isNaN(due.getTime()) && due < today) {
      add({ type: 'past-goal-date', severity: 'medium', title: `Review goal date: ${goal.title}`, detail: `The target date ${goal.dueDate} has passed with ${goal.progress}% progress.`, entityType: 'goal', entityId: goal.id, suggestedAction: 'Update the target date or revise the goal status.' });
    }
    if (!goal.projectIds?.length) {
      add({ type: 'goal-no-project', severity: 'low', title: `Goal has no linked project: ${goal.title}`, detail: 'There is no project connected to this goal yet.', entityType: 'goal', entityId: goal.id, suggestedAction: 'Link a project or add a concrete next task.' });
    }
  }

  const severityRank = { high: 0, medium: 1, low: 2 };
  return reviews.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.createdAt.localeCompare(b.createdAt));
}

export function createApiServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const method = request.method || 'GET';
      if (url.pathname === '/api/health' && method === 'GET') return send(response, 200, { ok: true, database: 'file-backed JSON', path: 'backend/data/lifeos.json' });
      const data = await readDatabase();

      if (url.pathname === '/api/records/seed' && method === 'POST') {
        const body = await readBody(request);
        data.records ||= {};
        data.seededCollections ||= {};
        const allowed = new Set(['businesses', 'companies', 'products', 'websites', 'domains', 'investments', 'transactions', 'income', 'expenses', 'events', 'resources', 'servers', 'budgets', 'assets', 'liabilities', 'accounts', 'messages', 'holdings', 'development-projects']);
        const seeded = {};
        for (const [collection, records] of Object.entries(body)) {
          if (!allowed.has(collection) || !Array.isArray(records) || data.seededCollections[collection] || data.records[collection]?.length) continue;
          data.records[collection] = records.map((record) => ({ id: `${collection}-${crypto.randomUUID()}`, ...record, isPlaceholder: true }));
          data.seededCollections[collection] = true;
          seeded[collection] = data.records[collection].length;
        }
        if (Object.keys(seeded).length) await writeDatabase(data);
        return send(response, 200, { seeded });
      }
      if (url.pathname === '/api/knowledge/search' && method === 'GET') {
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const format = (url.searchParams.get('format') || '').trim().toLowerCase();
        if (!query) return send(response, 200, { query, results: [] });
        const terms = [...new Set(query.split(/\s+/).filter((term) => term.length > 1))];
        const results = (data.records?.resources || []).map((record) => {
          const values = Array.isArray(record.values) ? record.values : [];
          const searchable = [record.title, record.content, record.notes, record.url, record.tags, ...values].filter(Boolean).join(' ').toLowerCase();
          const recordFormat = String(values[2] || record.format || '').toLowerCase();
          if (format && format !== 'all' && recordFormat !== format) return null;
          const title = String(record.title || values[0] || '');
          const titleText = title.toLowerCase();
          const score = terms.reduce((total, term) => {
            const occurrences = (searchable.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
            return total + occurrences + (titleText.includes(term) ? 4 : 0);
          }, 0) + (searchable.includes(query) ? 8 : 0);
          if (!score) return null;
          const detail = String(record.content || record.notes || values[3] || '');
          const excerpt = detail.slice(0, 260);
          return { id: record.id, title, author: values[1] || record.author || '', format: recordFormat || 'other', topic: values[3] || record.topic || '', url: record.url || '', tags: record.tags || '', excerpt, score };
        }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 30);
        return send(response, 200, { query, results });
      }
      if (url.pathname === '/api/state' && method === 'GET') return send(response, 200, { goals: data.goals, projects: data.projects, tasks: data.tasks, records: data.records || {}, summaries: data.summaries, reviews: data.reviews });
      const recordMatch = url.pathname.match(/^\/api\/records\/([a-z-]+)$/);
      const recordItemMatch = url.pathname.match(/^\/api\/records\/([a-z-]+)\/([^/]+)$/);
      if (recordMatch && method === 'GET') return send(response, 200, { records: data.records?.[recordMatch[1]] || [] });
      if (recordMatch && method === 'POST') {
        const body = await readBody(request);
        const collection = recordMatch[1];
        const allowed = new Set(['businesses', 'companies', 'products', 'websites', 'domains', 'investments', 'transactions', 'income', 'expenses', 'events', 'resources', 'servers', 'budgets', 'assets', 'liabilities', 'accounts', 'messages', 'holdings', 'development-projects']);
        if (!allowed.has(collection)) return send(response, 404, { error: 'Record collection not found.' });
        if (!body.title?.trim()) return send(response, 400, { error: 'A name or title is required.' });
        data.records ||= {};
        data.records[collection] ||= [];
        data.seededCollections ||= {};
        data.seededCollections[collection] = true;
        const record = { id: `${collection}-${crypto.randomUUID()}`, ...body, title: body.title.trim(), createdAt: new Date().toISOString() };
        data.records[collection].unshift(record);
        await writeDatabase(data);
        return send(response, 201, record);
      }
      if (recordItemMatch && ['PATCH', 'DELETE'].includes(method)) {
        const [, collection, recordId] = recordItemMatch;
        const records = data.records?.[collection];
        const index = records?.findIndex((item) => item.id === recordId) ?? -1;
        if (index < 0) return send(response, 404, { error: 'Record not found.' });
        if (method === 'DELETE') {
          const [deleted] = records.splice(index, 1);
          await writeDatabase(data);
          return send(response, 200, deleted);
        }
        const body = await readBody(request);
        records[index] = { ...records[index], ...body, id: records[index].id, updatedAt: new Date().toISOString() };
        await writeDatabase(data);
        return send(response, 200, records[index]);
      }
      if (url.pathname === '/api/reviews' && method === 'GET') return send(response, 200, { reviews: data.reviews.filter((review) => !review.dismissed) });
      if (url.pathname === '/api/reviews/run' && method === 'POST') {
        const newReviews = createReviews(data);
        data.reviews = [...newReviews, ...data.reviews.filter((review) => review.dismissed)];
        await writeDatabase(data);
        return send(response, 200, { reviews: newReviews, ranAt: new Date().toISOString(), summary: { total: newReviews.length, high: newReviews.filter((r) => r.severity === 'high').length, medium: newReviews.filter((r) => r.severity === 'medium').length, low: newReviews.filter((r) => r.severity === 'low').length } });
      }
      const dismissMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/dismiss$/);
      if (dismissMatch && method === 'POST') {
        const review = data.reviews.find((item) => item.id === dismissMatch[1]);
        if (!review) return send(response, 404, { error: 'Review not found.' });
        review.dismissed = true;
        review.dismissedAt = new Date().toISOString();
        await writeDatabase(data);
        return send(response, 200, review);
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && method === 'DELETE') {
        const index = data.tasks.findIndex((item) => item.id === taskMatch[1]);
        if (index < 0) return send(response, 404, { error: 'Task not found.' });
        const [deleted] = data.tasks.splice(index, 1);
        await writeDatabase(data);
        return send(response, 200, deleted);
      }
      if (taskMatch && method === 'PATCH') {
        const task = data.tasks.find((item) => item.id === taskMatch[1]);
        if (!task) return send(response, 404, { error: 'Task not found.' });
        const body = await readBody(request);
        if (body.status !== undefined) task.status = body.status;
        if (body.dueDate !== undefined) task.dueDate = body.dueDate;
        if (body.title !== undefined) task.title = body.title;
        task.completedAt = task.status === 'Completed' ? new Date().toISOString() : null;
        task.updatedAt = new Date().toISOString();
        await writeDatabase(data);
        return send(response, 200, task);
      }
      if (url.pathname === '/api/tasks' && method === 'POST') {
        const body = await readBody(request);
        if (!body.title?.trim()) return send(response, 400, { error: 'Task title is required.' });
        const task = { id: `task-${crypto.randomUUID()}`, title: body.title.trim(), description: body.description || '', projectId: body.projectId || null, priority: body.priority || 'Medium', status: body.status || 'To Do', dueDate: body.dueDate || null, assignee: 'You', completedAt: null, updatedAt: new Date().toISOString(), isPlaceholder: false };
        data.tasks.unshift(task);
        data.summaries.totalTasks = Math.max(data.summaries.totalTasks || 0, data.tasks.length);
        await writeDatabase(data);
        return send(response, 201, task);
      }
      if (url.pathname === '/api/goals' && method === 'POST') {
        const body = await readBody(request);
        if (!body.title?.trim()) return send(response, 400, { error: 'Goal title is required.' });
        const goal = { id: `goal-${crypto.randomUUID()}`, title: body.title.trim(), description: body.description || '', category: body.category || 'Personal Goals', progress: 0, targetValue: body.targetValue || 'Not set', currentValue: body.currentValue || '0', dueDate: body.dueDate || null, dueLabel: body.dueDate || 'Not set', status: 'On track', projectIds: [], updatedAt: new Date().toISOString(), isPlaceholder: false };
        data.goals.push(goal);
        await writeDatabase(data);
        return send(response, 201, goal);
      }
      const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
      if (goalMatch && ['PATCH', 'DELETE'].includes(method)) {
        const index = data.goals.findIndex((item) => item.id === goalMatch[1]);
        if (index < 0) return send(response, 404, { error: 'Goal not found.' });
        if (method === 'DELETE') { const [deleted] = data.goals.splice(index, 1); await writeDatabase(data); return send(response, 200, deleted); }
        const body = await readBody(request); data.goals[index] = { ...data.goals[index], ...body, id: data.goals[index].id, updatedAt: new Date().toISOString() }; await writeDatabase(data); return send(response, 200, data.goals[index]);
      }
      if (url.pathname === '/api/projects' && method === 'POST') {
        const body = await readBody(request);
        if (!body.name?.trim()) return send(response, 400, { error: 'Project name is required.' });
        const project = { id: `project-${crypto.randomUUID()}`, name: body.name.trim(), type: body.type || 'Personal Project', progress: 0, taskCount: 0, overdueTasks: 0, status: 'active', updatedAt: new Date().toISOString(), goalIds: [], description: body.description || '', isPlaceholder: false };
        data.projects.push(project);
        data.summaries.totalProjects = (data.summaries.totalProjects || 0) + 1;
        data.summaries.activeProjects = (data.summaries.activeProjects || 0) + 1;
        await writeDatabase(data);
        return send(response, 201, project);
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && ['PATCH', 'DELETE'].includes(method)) {
        const index = data.projects.findIndex((item) => item.id === projectMatch[1]);
        if (index < 0) return send(response, 404, { error: 'Project not found.' });
        if (method === 'DELETE') { const [deleted] = data.projects.splice(index, 1); await writeDatabase(data); return send(response, 200, deleted); }
        const body = await readBody(request); data.projects[index] = { ...data.projects[index], ...body, id: data.projects[index].id, updatedAt: new Date().toISOString() }; await writeDatabase(data); return send(response, 200, data.projects[index]);
      }
      return send(response, 404, { error: 'API route not found.' });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApiServer();
  server.listen(3001, '127.0.0.1', () => console.log('LifeOS API listening on http://127.0.0.1:3001'));
}
