import type { ActionContext, ActionHandler } from '../action.js';
import type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CellValue,
  CreateDocInput,
  CreateDocOutput,
  DeleteBitableRecordsInput,
  DeleteBitableRecordsOutput,
  DeleteDocInput,
  DeleteDocOutput,
  ExportDocInput,
  ExportDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  GetExportArtifactInput,
  GetExportArtifactOutput,
  MoveDocInput,
  MoveDocOutput,
  ReadBitableRecordsInput,
  UpdateBitableRecordsInput,
  UpdateBitableRecordsOutput,
  ReadBitableRecordsOutput,
  ReadSheetCellsInput,
  ReadSheetCellsOutput,
  RenameDocInput,
  RenameDocOutput,
  SearchDocsInput,
  SearchDocsOutput,
  WriteBitableRecordsInput,
  WriteBitableRecordsOutput,
  WriteSheetCellsInput,
  WriteSheetCellsOutput,
} from '../actions.js';
import type { ConnectorManifest, IConnector } from '../connector.js';
import { ActionError } from '../errors.js';
import { toArtifactOutput } from '../actions.js';
import type { RateLimitDeclaration } from '../rate-limit.js';
import { parseRange, sliceValues, writeValues, type RangeRef } from './range.js';
import type { DownloadedFile } from '../upstream-http.js';

export const FAKE_CONNECTOR_ID = 'fake';

/** MIME types the fake reports for exported artifacts, keyed by format. */
const FAKE_EXPORT_CONTENT_TYPES: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** A spreadsheet inside the fake connector (T9): one sheet, id + name. */
export interface FakeSheet {
  sheetId: string;
  sheetName: string;
  values: CellValue[][];
}

/** A Bitable table inside the fake connector (T9): records keyed by name. */
export type FakeBitable = Map<string, Array<{ record_id: string; fields: Record<string, unknown> }>>;

/** A document stored inside the fake connector, keyed by the platform doc_id. */
export interface FakeDoc {
  doc_id: string;
  title: string;
  content: string;
  folder_id?: string;
  /** Present when the doc is a spreadsheet (T9). */
  sheet?: FakeSheet;
  /** Present when the doc is a Bitable app (T9). */
  bitable?: FakeBitable;
}

/**
 * In-memory connector used as the test double at Seam A (the action
 * execution boundary) and for local demos. It registers through the same
 * `IConnector` adapter contract as real connectors (ADR-0003): a manifest
 * declaring the platform actions it implements, plus a private handlers
 * record. It maps platform `doc_id`/`folder_id` trivially to its own ids,
 * which ADR-0001 permits for v1.
 */
export class FakeConnector implements IConnector {
  readonly manifest: ConnectorManifest;

  private readonly docs = new Map<string, FakeDoc>();
  /** Export artifacts by artifact_id (#43): export_doc creates, get_export_artifact downloads. */
  private readonly artifacts = new Map<string, DownloadedFile>();
  private readonly handlers: Record<string, ActionHandler>;

  constructor(
    initialDocs: FakeDoc[] = [],
    opts: { rateLimit?: RateLimitDeclaration } = {},
  ) {
    this.manifest = {
      id: FAKE_CONNECTOR_ID,
      // The fake connector implements the feishu-native bitable actions, so
      // its declared provider is feishu (ADR-0013): the registry enforces
      // that pairing at registration.
      provider: 'feishu',
      implements: [
        'test_connection',
        'create_doc',
        'search_docs',
        'get_doc_content',
        'get_doc_metadata',
        'append_doc_content',
        'rename_doc',
        'move_doc',
        'delete_doc',
        'export_doc',
        'get_export_artifact',
        'read_sheet_cells',
        'write_sheet_cells',
        'feishu_read_bitable_records',
        'feishu_write_bitable_records',
        'feishu_update_bitable_records',
        'feishu_delete_bitable_records',
      ],
      ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    };
    for (const doc of initialDocs) this.docs.set(doc.doc_id, { ...doc });
    this.handlers = {
      test_connection: (_args, ctx) => ({ connection_id: ctx.connectionId, status: 'ok' }),
      create_doc: (args: CreateDocInput) => this.createDoc(args),
      search_docs: (args: SearchDocsInput) => this.searchDocs(args),
      get_doc_content: (args: GetDocContentInput) => this.getDocContent(args),
      get_doc_metadata: (args: GetDocMetadataInput) => this.getDocMetadata(args),
      append_doc_content: (args: AppendDocContentInput) => this.appendDocContent(args),
      rename_doc: (args: RenameDocInput) => this.renameDoc(args),
      move_doc: (args: MoveDocInput) => this.moveDoc(args),
      delete_doc: (args: DeleteDocInput) => this.deleteDoc(args),
      export_doc: (args: ExportDocInput) => this.exportDoc(args),
      get_export_artifact: (args: GetExportArtifactInput) => this.getExportArtifact(args),
      read_sheet_cells: (args: ReadSheetCellsInput) => this.readSheetCells(args),
      write_sheet_cells: (args: WriteSheetCellsInput) => this.writeSheetCells(args),
      feishu_read_bitable_records: (args: ReadBitableRecordsInput) => this.readBitableRecords(args),
      feishu_write_bitable_records: (args: WriteBitableRecordsInput) => this.writeBitableRecords(args),
      feishu_update_bitable_records: (args: UpdateBitableRecordsInput) => this.updateBitableRecords(args),
      feishu_delete_bitable_records: (args: DeleteBitableRecordsInput) => this.deleteBitableRecords(args),
    };
  }

  execute(action: string, args: unknown, ctx: ActionContext): Promise<unknown> {
    const handler = this.handlers[action];
    if (!handler) {
      return Promise.reject(
        new Error(`Action "${action}" is not implemented by connector "${FAKE_CONNECTOR_ID}"`),
      );
    }
    return Promise.resolve(handler(args, ctx));
  }

  private createDoc(args: CreateDocInput): CreateDocOutput {
    const doc_id =
      args.doc_type === 'sheet' ? `sht_${crypto.randomUUID()}` : `doc_${crypto.randomUUID()}`;
    // #64: the fake models the canonical contract — 'sheet' creates an
    // empty spreadsheet the cell actions address immediately; seeded
    // content is text-only and rejected for sheets exactly like the
    // real connectors (ADR-0014 §4).
    const sheet: FakeSheet | undefined =
      args.doc_type === 'sheet'
        ? { sheetId: `${doc_id}-sheet1`, sheetName: 'Sheet1', values: [] }
        : undefined;
    if (sheet && args.content !== undefined && args.content !== '') {
      throw new ActionError(
        'validation_error',
        'content cannot seed a sheet (doc_type "sheet"): write cells with write_sheet_cells after create_doc instead',
      );
    }
    const doc: FakeDoc = {
      doc_id,
      title: args.title,
      content: args.content ?? '',
      ...(args.folder_id !== undefined ? { folder_id: args.folder_id } : {}),
      ...(sheet !== undefined ? { sheet } : {}),
    };
    this.docs.set(doc_id, doc);
    return { doc_id, title: doc.title };
  }

  private searchDocs(args: SearchDocsInput): SearchDocsOutput {
    const needle = args.query.toLowerCase();
    const limit = args.limit ?? 50;
    // #42: the fake honors the cursor contract like the real Feishu
    // connector — page_token is an opaque offset cursor, next is set iff
    // another page exists (Seam A tests can exercise pagination).
    const offset = Number(args.page_token ?? '0') || 0;
    const matched = [...this.docs.values()]
      .filter((doc) => doc.title.toLowerCase().includes(needle))
      .reverse();
    const docs = matched
      .slice(offset, offset + limit)
      .map((doc) => ({ doc_id: doc.doc_id, title: doc.title, doc_type: 'docx' }));
    const hasMore = offset + docs.length < matched.length;
    return { data: docs, next: hasMore ? String(offset + limit) : null };
  }

  private getDocContent(args: GetDocContentInput): GetDocContentOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      // Connector-owned error code (ADR-0005): passed through by executeAction.
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    return { doc_id: doc.doc_id, content: doc.content };
  }

  private getDocMetadata(args: GetDocMetadataInput): GetDocMetadataOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    return {
      doc_id: doc.doc_id,
      title: doc.title,
      owner_id: 'fake-owner',
      doc_type: 'docx',
      edited_at: '2026-01-01T00:00:00.000Z',
    };
  }

  private appendDocContent(args: AppendDocContentInput): AppendDocContentOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    doc.content = doc.content === '' ? args.content : `${doc.content}\n${args.content}`;
    return { doc_id: doc.doc_id, content: doc.content };
  }

  private renameDoc(args: RenameDocInput): RenameDocOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    doc.title = args.new_title;
    return { doc_id: doc.doc_id, title: doc.title };
  }

  private moveDoc(args: MoveDocInput): MoveDocOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    doc.folder_id = args.folder_id;
    return { doc_id: doc.doc_id, folder_id: doc.folder_id };
  }

  /**
   * The fake's destructive delete (ADR-0018): removes the doc (and its
   * sheet/bitable payload) from the in-memory drive — gone is gone, the
   * fake has no trash.
   */
  private deleteDoc(args: DeleteDocInput): DeleteDocOutput {
    const doc = this.requireDoc(args.doc_id);
    this.docs.delete(doc.doc_id);
    return { doc_id: doc.doc_id };
  }

  private exportDoc(args: ExportDocInput): ExportDocOutput {
    const doc = this.requireDoc(args.doc_id);
    const artifactId = `export_${doc.doc_id}_${args.format}`;
    this.artifacts.set(artifactId, {
      bytes: new TextEncoder().encode(`FAKE-EXPORT-${artifactId}`),
      contentType: FAKE_EXPORT_CONTENT_TYPES[args.format] ?? 'application/octet-stream',
    });
    return {
      doc_id: doc.doc_id,
      format: args.format,
      artifact_id: artifactId,
      url: `https://fake.totem.local/exports/${doc.doc_id}.${args.format}`,
    };
  }

  private getExportArtifact(args: GetExportArtifactInput): GetExportArtifactOutput {
    const artifact = this.artifacts.get(args.artifact_id);
    if (!artifact) {
      throw new ActionError('not_found', `Artifact "${args.artifact_id}" not found`);
    }
    return toArtifactOutput(args.artifact_id, artifact);
  }

  private readSheetCells(args: ReadSheetCellsInput): ReadSheetCellsOutput {
    const doc = this.requireSheet(args.doc_id);
    const ref = this.parseSheetRange(doc, args);
    return { doc_id: doc.doc_id, range: args.range, data: sliceValues(doc.sheet.values, ref), next: null };
  }

  private writeSheetCells(args: WriteSheetCellsInput): WriteSheetCellsOutput {
    const doc = this.requireSheet(args.doc_id);
    const ref = this.parseSheetRange(doc, args);
    const height = ref.rowEnd - ref.rowStart + 1;
    const width = ref.colEnd - ref.colStart + 1;
    if (args.values.length !== height || args.values.some((row) => row.length !== width)) {
      throw new ActionError(
        'upstream_error',
        `values shape (${args.values.length} x ${args.values[0]?.length ?? 0}) does not match range "${args.range}" (${height} x ${width})`,
      );
    }
    const updated = writeValues(doc.sheet.values, ref, args.values);
    return {
      doc_id: doc.doc_id,
      range: args.range,
      updated_cells: updated.updatedCells,
    };
  }

  /**
   * Mirrors the pinned sheet contract (live-verified): sheet_name selects
   * the tab (unknown → not_found), the range is a bare cell range, and a
   * prefixed range must carry the SHEET ID (names are rejected, like the
   * real API's 90215).
   */
  private parseSheetRange(
    doc: FakeDoc & { sheet: FakeSheet },
    args: { sheet_name?: string; range: string },
  ): RangeRef {
    if (args.sheet_name !== undefined && args.sheet_name !== doc.sheet.sheetName) {
      throw new ActionError('not_found', `Sheet "${args.sheet_name}" not found`);
    }
    const ref = parseRange(args.range);
    if (!ref || (ref.sheet !== undefined && ref.sheet !== doc.sheet.sheetId)) {
      throw new ActionError('not_found', `Spreadsheet range "${args.range}" not found`);
    }
    return ref;
  }

  private readBitableRecords(args: ReadBitableRecordsInput): ReadBitableRecordsOutput {
    const doc = this.requireDoc(args.doc_id);
    const records = this.requireTable(doc, args.table_name);
    // #42: the fake honors the cursor contract like the real connector.
    const offset = Number(args.page_token ?? '0') || 0;
    const limit = args.limit ?? 100;
    const page = records.slice(offset, offset + limit);
    const hasMore = offset + page.length < records.length;
    return {
      doc_id: doc.doc_id,
      table_name: args.table_name,
      data: page,
      next: hasMore ? String(offset + limit) : null,
    };
  }

  private writeBitableRecords(args: WriteBitableRecordsInput): WriteBitableRecordsOutput {
    const doc = this.requireDoc(args.doc_id);
    const records = this.requireTable(doc, args.table_name);
    const record = { record_id: `rec_${crypto.randomUUID()}`, fields: { ...args.fields } };
    records.push(record);
    return { doc_id: doc.doc_id, table_name: args.table_name, record_id: record.record_id };
  }

  private updateBitableRecords(args: UpdateBitableRecordsInput): UpdateBitableRecordsOutput {
    const doc = this.requireDoc(args.doc_id);
    const records = this.requireTable(doc, args.table_name);
    const record = records.find((r) => r.record_id === args.record_id);
    if (!record) {
      throw new ActionError(
        'not_found',
        `Record "${args.record_id}" not found in table "${args.table_name}"`,
      );
    }
    record.fields = { ...record.fields, ...args.fields };
    return {
      doc_id: doc.doc_id,
      table_name: args.table_name,
      record_id: record.record_id,
      fields: { ...record.fields },
    };
  }

  /**
   * The fake's batch delete (ADR-0018): all requested ids must exist — a
   * missing id is not_found — and success deletes the whole batch (the
   * real batch_delete behaves as a unit; the output count is the batch
   * size).
   */
  private deleteBitableRecords(args: DeleteBitableRecordsInput): DeleteBitableRecordsOutput {
    const doc = this.requireDoc(args.doc_id);
    const records = this.requireTable(doc, args.table_name);
    const doomed = args.record_ids.map((recordId) => {
      const record = records.find((r) => r.record_id === recordId);
      if (!record) {
        throw new ActionError(
          'not_found',
          `Record "${recordId}" not found in table "${args.table_name}"`,
        );
      }
      return record;
    });
    for (const record of doomed) {
      const index = records.indexOf(record);
      records.splice(index, 1);
    }
    return {
      doc_id: doc.doc_id,
      table_name: args.table_name,
      deleted_count: doomed.length,
    };
  }

  private requireDoc(docId: string): FakeDoc {
    const doc = this.docs.get(docId);
    if (!doc) {
      throw new ActionError('not_found', `Document "${docId}" not found`);
    }
    return doc;
  }

  private requireSheet(docId: string): FakeDoc & { sheet: FakeSheet } {
    const doc = this.requireDoc(docId);
    if (!doc.sheet) {
      throw new ActionError('not_found', `Spreadsheet "${docId}" not found`);
    }
    return doc as FakeDoc & { sheet: FakeSheet };
  }

  private requireTable(
    doc: FakeDoc,
    tableName: string,
  ): Array<{ record_id: string; fields: Record<string, unknown> }> {
    const records = doc.bitable?.get(tableName);
    if (!records) {
      throw new ActionError('not_found', `Bitable table "${tableName}" not found`);
    }
    return records;
  }
}
