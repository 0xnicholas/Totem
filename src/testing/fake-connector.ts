import type { ActionContext, ActionHandler } from '../action.js';
import type { CreateDocInput, CreateDocOutput, ListDocsInput, ListDocsOutput, ReadDocInput, ReadDocOutput } from '../actions.js';
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
    implements: ['create_doc', 'read_doc', 'list_docs'],
  };

  private readonly docs = new Map<string, FakeDoc>();
  private readonly handlers: Record<string, ActionHandler>;

  constructor(initialDocs: FakeDoc[] = []) {
    for (const doc of initialDocs) this.docs.set(doc.doc_id, { ...doc });
    this.handlers = {
      create_doc: (args: CreateDocInput) => this.createDoc(args),
      read_doc: (args: ReadDocInput) => this.readDoc(args),
      list_docs: (args: ListDocsInput) => this.listDocs(args),
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

  private readDoc(args: ReadDocInput): ReadDocOutput {
    const doc = this.docs.get(args.doc_id);
    if (!doc) {
      // Connector-owned error code (ADR-0005): passed through by executeAction.
      throw new ActionError('not_found', `Document "${args.doc_id}" not found`);
    }
    return { doc_id: doc.doc_id, title: doc.title, content: doc.content };
  }

  private listDocs(args: ListDocsInput): ListDocsOutput {
    const limit = args.limit ?? 50;
    const docs = [...this.docs.values()]
      .reverse()
      .slice(0, limit)
      .map((doc) => ({ doc_id: doc.doc_id, title: doc.title }));
    return { docs };
  }
}
