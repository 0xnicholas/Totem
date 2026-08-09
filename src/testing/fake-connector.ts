import type { ActionContext, ActionHandler } from '../action.js';
import type {
  CreateDocInput,
  CreateDocOutput,
  GetDocContentInput,
  GetDocContentOutput,
  GetDocMetadataInput,
  GetDocMetadataOutput,
  SearchDocsInput,
  SearchDocsOutput,
} from '../actions.js';
import type { ConnectorManifest, IConnector } from '../connector.js';
import { ActionError } from '../errors.js';

export const FAKE_CONNECTOR_ID = 'fake';

/** A document stored inside the fake connector, keyed by the platform doc_id. */
export interface FakeDoc {
  doc_id: string;
  title: string;
  content: string;
  folder_id?: string;
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
    implements: ['create_doc', 'search_docs', 'get_doc_content', 'get_doc_metadata'],
  };

  private readonly docs = new Map<string, FakeDoc>();
  private readonly handlers: Record<string, ActionHandler>;

  constructor(initialDocs: FakeDoc[] = []) {
    for (const doc of initialDocs) this.docs.set(doc.doc_id, { ...doc });
    this.handlers = {
      create_doc: (args: CreateDocInput) => this.createDoc(args),
      search_docs: (args: SearchDocsInput) => this.searchDocs(args),
      get_doc_content: (args: GetDocContentInput) => this.getDocContent(args),
      get_doc_metadata: (args: GetDocMetadataInput) => this.getDocMetadata(args),
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
    return { doc_id, title: doc.title, url: `https://fake.totem.local/docs/${doc_id}` };
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
}
