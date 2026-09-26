import { isAdminAuthenticated, errorResponse, jsonResponse, markHomeCacheDirty } from '../../_middleware';

export async function onRequestPost(context) {
  const { request, env } = context;
  const REORDER_CHUNK_SIZE = 100;
  
  if (!(await isAdminAuthenticated(request, env))) {
    return errorResponse('Unauthorized', 401);
  }

  // reorder 之外的操作都是单次 env.NAV_DB.batch()（D1 隐式单事务），失败即全无变更，
  // 成功后就地打一次脏标记即可。reorder 分块提交属于多事务写入，改用 finally 打标：
  // KV 对同一个 key 限制每秒一次写入，同一请求内写两次可能被静默丢弃，
  // 而 finally 一次就能覆盖成功与抛错两种出口。
  let dbMayHaveChanged = false;

  try {
    const { action, ids, payload } = await request.json();

    const requiresIds = action !== 'reorder';

    if (requiresIds && (!ids || !Array.isArray(ids) || ids.length === 0)) {
      return errorResponse('未提供 ID', 400);
    }

    // Cloudflare D1 限制单条语句变量数为 100。
    // 在更新操作中，除了 ID 列表（Chunk），还有 SET 部分的参数（如 catelog_id, catelog_name）。
    // 将分块大小设为 50 以确保变量总数绝对不会超过 100。
    const CHUNK_SIZE = 50;
    const chunks = [];
    if (requiresIds) {
      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        chunks.push(ids.slice(i, i + CHUNK_SIZE));
      }
    }

    const statements = [];

    if (action === 'delete') {
      chunks.forEach(chunk => {
        const placeholders = chunk.map(() => '?').join(',');
        statements.push(
          env.NAV_DB.prepare(`DELETE FROM sites WHERE id IN (${placeholders})`).bind(...chunk)
        );
      });

      await env.NAV_DB.batch(statements);
      await markHomeCacheDirty(env, 'all');
      
      return jsonResponse({
        code: 200,
        message: `成功删除 ${ids.length} 条项目`
      });

    } else if (action === 'update_category') {
      const { categoryId } = payload;
      if (!categoryId) {
        return errorResponse('分类 ID 是必填项', 400);
      }

      const category = await env.NAV_DB.prepare('SELECT catelog, is_private FROM category WHERE id = ?').bind(categoryId).first();
      if (!category) {
        return errorResponse('找不到分类', 404);
      }

      let baseSql = `UPDATE sites SET catelog_id = ?, catelog_name = ?`;
      const baseParams = [categoryId, category.catelog];

      if (category.is_private === 1) {
          baseSql += `, is_private = 1`;
      }

      chunks.forEach(chunk => {
        const placeholders = chunk.map(() => '?').join(',');
        statements.push(
          env.NAV_DB.prepare(`${baseSql} WHERE id IN (${placeholders})`).bind(...baseParams, ...chunk)
        );
      });

      await env.NAV_DB.batch(statements);
      await markHomeCacheDirty(env, 'all');

      return jsonResponse({
        code: 200,
        message: `成功更新 ${ids.length} 条项目的分类`
      });

    } else if (action === 'update_privacy') {
      const { isPrivate } = payload;
      if (isPrivate === undefined) {
        return errorResponse('隐私状态是必填项', 400);
      }
      
      const isPrivateValue = isPrivate ? 1 : 0;
      
      chunks.forEach(chunk => {
        const placeholders = chunk.map(() => '?').join(',');
        statements.push(
          env.NAV_DB.prepare(`UPDATE sites SET is_private = ? WHERE id IN (${placeholders})`).bind(isPrivateValue, ...chunk)
        );
      });

      await env.NAV_DB.batch(statements);
      await markHomeCacheDirty(env, 'all');

      return jsonResponse({
        code: 200,
        message: `成功更新 ${ids.length} 条项目的隐私属性`
      });
    } else if (action === 'reorder') {
      const orderedIds = payload?.orderedIds;
      const page = Number(payload?.page);
      const pageSize = Number(payload?.pageSize);
      const rawCatalogId = payload?.catalogId;
      const hasCatalog = rawCatalogId !== undefined && rawCatalogId !== null && rawCatalogId !== '';
      const catalogId = hasCatalog ? Number(rawCatalogId) : null;

      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return errorResponse('排序数据不能为空', 400);
      }

      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
        return errorResponse('分页参数无效', 400);
      }

      if (hasCatalog && (!Number.isInteger(catalogId) || catalogId <= 0)) {
        return errorResponse('分类 ID 无效', 400);
      }

      const normalizedIds = orderedIds.map(Number);
      if (normalizedIds.some(id => !Number.isInteger(id) || id <= 0)) {
        return errorResponse('排序数据格式无效', 400);
      }
      if (new Set(normalizedIds).size !== normalizedIds.length) {
        return errorResponse('排序数据包含重复 ID', 400);
      }

      if (hasCatalog) {
        const category = await env.NAV_DB.prepare('SELECT id FROM category WHERE id = ?').bind(catalogId).first();
        if (!category) {
          return errorResponse('找不到分类', 404);
        }
      }

      const sitesQuery = hasCatalog
        ? env.NAV_DB.prepare(
          'SELECT id FROM sites WHERE catelog_id = ? ORDER BY sort_order ASC, create_time DESC, id ASC'
        ).bind(catalogId)
        : env.NAV_DB.prepare(
          'SELECT id FROM sites ORDER BY sort_order ASC, create_time DESC, id ASC'
        );
      const { results = [] } = await sitesQuery.all();
      const scopedIds = results.map(row => Number(row.id));
      const startIndex = (page - 1) * pageSize;
      const currentPageIds = scopedIds.slice(startIndex, startIndex + pageSize);

      if (currentPageIds.length !== normalizedIds.length) {
        return errorResponse('列表已发生变化，请刷新后重试', 409);
      }

      const expectedIds = new Set(currentPageIds);
      if (normalizedIds.some(id => !expectedIds.has(id))) {
        return errorResponse(hasCatalog ? '排序数据包含其他分类的 ID' : '排序数据与当前页不一致，请刷新后重试', 409);
      }

      scopedIds.splice(startIndex, normalizedIds.length, ...normalizedIds);
      const reorderStatements = scopedIds.map((id, sortOrder) =>
        env.NAV_DB.prepare(
          'UPDATE sites SET sort_order = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?'
        ).bind(sortOrder, id)
      );

      dbMayHaveChanged = true;
      const resultsByChunk = [];
      for (let i = 0; i < reorderStatements.length; i += REORDER_CHUNK_SIZE) {
        const chunkResults = await env.NAV_DB.batch(reorderStatements.slice(i, i + REORDER_CHUNK_SIZE));
        resultsByChunk.push(...chunkResults);
      }

      const updatedCount = resultsByChunk.reduce((total, result) => total + Number(result?.meta?.changes || 0), 0);
      if (updatedCount !== scopedIds.length) {
        throw new Error(`排序更新行数不匹配：预期 ${scopedIds.length}，实际 ${updatedCount}`);
      }

      return jsonResponse({
        code: 200,
        message: `成功重新编号 ${scopedIds.length} 条项目`
      });
    } else {
      return errorResponse('无效的操作', 400);
    }

  } catch (e) {
    return errorResponse(`批量操作失败: ${e.message}`, 500);
  } finally {
    if (dbMayHaveChanged) {
      await markHomeCacheDirty(env, 'all');
    }
  }
}
