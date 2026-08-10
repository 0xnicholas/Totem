import type { ActionContext, ActionHandler } from '../action.js';
import type {
  AppendDocContentInput,
  AppendDocContentOutput,
  CellValue,
  CreateDocInput,
  CreateDocOutput,
  ExportDocInput,
  ExportDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  MoveDocInput,
  MoveDocOutput,
  ReadBitableRecordsInput,
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
import { parseRange, sliceValues, writeValues, type RangeRef } from './range.js';

export const FAKE_CONNECTOR_ID = 'fake';

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
  readonly manifest: ConnectorManifest = {
    id: FAKE_CONNECTOR_ID,
    implements: [
      'test_connection',
      'create_doc',
      'search_docs',
      'get_doc_content',
      'get_doc_metadata',
      'append_doc_content',
      'rename_doc',
      'move_doc',
      'export_doc',
      'read_sheet_cells',
      'write_sheet_cells',
      'read_bitable_records',
      'write_bitable_records',
    ],
  };

  private readonly docs = new Map<string, FakeDoc>();
  private readonly handlers: Record<string, ActionHandler>;

  constructor(initialDocs: FakeDoc[] = []) {
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
      export_doc: (args: ExportDocInput) => this.exportDoc(args),
      read_sheet_cells: (args: ReadSheetCellsInput) => this.readSheetCells(args),
      write_sheet_cells: (args: WriteSheetCellsInput) => this.writeSheetCells(args),
      read_bitable_records: (args: ReadBitableRecordsInput) => this.readBitableRecords(args),
      write_bitable_records: (args: WriteBitableRecordsInput) => this.writeBitableRecords(args),
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
    const doc_id = `doc_${crypto.randomUUID()}`;
    const doc: FakeDoc = {
      doc_id,
      title: args.title,
      content: args.content ?? '',
      ...(args.folder_id !== undefined ? { folder_id: args.folder_id } : {}),
    };
    this.docs.set(doc_id, doc);
    return { doc_id, title: doc.title };
  }

  private searchDocs(args: SearchDocsInput): SearchDocsOutput {
    const needle = args.query.toLowerCase();
    const limit = args.limit ?? 50;
    const docs = [...this.docs.values()]
      .filter((doc) => doc.title.toLowerCase().includes(needle))
      .reverse()
      .slice(0, limit)
      .map((doc) => ({ doc_id: doc.doc_id, title: doc.title, doc_type: 'docx' }));
    return { docs };
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

  private exportDoc(args: ExportDocInput): ExportDocOutput {
    const doc = this.requireDoc(args.doc_id);
    return {
      doc_id: doc.doc_id,
      format: args.format,
      artifact_id: `export_${doc.doc_id}_${args.format}`,
      url: `https://fake.totem.local/exports/${doc.doc_id}.${args.format}`,
    };
  }

  private readSheetCells(args: ReadSheetCellsInput): ReadSheetCellsOutput {
    const doc = this.requireSheet(args.doc_id);
    const ref = this.parseSheetRange(doc, args);
    return { doc_id: doc.doc_id, range: args.range, values: sliceValues(doc.sheet.values, ref) };
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
    return {
      doc_id: doc.doc_id,
      table_name: args.table_name,
      records: records.slice(0, args.limit ?? 100),
    };
  }

  private writeBitableRecords(args: WriteBitableRecordsInput): WriteBitableRecordsOutput {
    const doc = this.requireDoc(args.doc_id);
    const records = this.requireTable(doc, args.table_name);
    const record = { record_id: `rec_${crypto.randomUUID()}`, fields: { ...args.fields } };
    records.push(record);
    return { doc_id: doc.doc_id, table_name: args.table_name, record_id: record.record_id };
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
