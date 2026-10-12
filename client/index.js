// dsh-github-tools, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page
// loads it as a script, the module loader below hands it a `require`, and the
// only module it asks for is React.
//
// What it contributes: the row configuration page for this bundle. The Plugins
// page declares `plugins.row.config` and gives a row a **Configure** control for
// every registration keyed by `<package name>#<row id>` — the key
// `ui-plugin-manager`'s `rowConfigKey` builds. This bundle's package name is
// `dsh-github-tools` and the row id in `cordis.patch.yml` is `github-tools`.
//
// Configuration read/write goes through the client `configForms` service,
// addressed by the Loader ROW id (not the package name: one package may be
// composed as several rows). Its scope offers
// `getSnapshot()` / `subscribe(listener)` / `mutate(ops, revision)`, a snapshot is
// `{ status, value, base, user, writable, revision }`, and one op is
// `{ op: 'set', path, value }` or `{ op: 'unset', path }`.

window.__ModuleLoader__.load({
  id: 'dsh-github-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Locale namespace for this plugin's copy. */
    const NS = 'dsh-github-tools'

    /**
     * Loader row id of this bundle's Host half, read from our own
     * `cordis.patch.yml`. `configForms.get` addresses a Host configuration entry
     * by that row id.
     */
    const CONFIG_ROW_ID = 'github-tools'

    /** The `plugins.row.config` key: `<package name>#<row id>`. */
    const SLOT_KEY = 'dsh-github-tools#github-tools'

    // ------------------------------------------------------------------ copy

    const zh = {
      summary: '令牌、toolset 与只读开关',
      intro: '这些设置写入本插件的配置行，保存后立即生效：工具集会实时重新注册，不需要重启 DSH。',
      token: 'Personal Access Token',
      tokenHint: '留空时依次回退到环境变量 GITHUB_PERSONAL_ACCESS_TOKEN、GITHUB_TOKEN、GH_TOKEN。',
      toolsets: 'Toolset',
      toolsetsHint: '逗号分隔。default = 上游默认的 6 个 toolset（86 个工具）；all = 全部 131 个。',
      readOnly: '只读模式',
      readOnlyHint: '只注册上游标记为只读的工具，写操作全部隐藏。',
      deferLoading: '延迟加载工具定义',
      deferLoadingHint: '让宿主按需加载工具定义，减少上下文占用。',
      advanced: '高级',
      host: 'GitHub 主机',
      hostHint: 'github.com，或 GitHub Enterprise 的主机名。',
      apiBaseUrl: 'REST 基址',
      apiBaseUrlHint: '留空按 host 自动推导。',
      graphqlUrl: 'GraphQL 端点',
      graphqlUrlHint: '留空按 host 自动推导。',
      timeoutMs: '单次请求超时（毫秒）',
      retries: '重试次数（429/5xx）',
      maxItems: '单次分页条目上限',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      failed: '保存失败：可能被更高优先级的配置覆盖，或当前配置不可写',
      dirty: '有未保存的修改',
      reset: '还原修改',
      loading: '正在读取配置…',
      unavailable: '当前 DSH 未提供该插件的配置作用域（configForms），无法在此调整。',
      notWritable: '当前配置不可写（由更高优先级的补丁层提供）。',
    }

    const en = {
      summary: 'Token, toolsets and the read-only switch',
      intro: 'These settings are written to this plugin’s configuration row and apply immediately: the tool set is re-registered live, with no DSH restart.',
      token: 'Personal access token',
      tokenHint: 'When empty, GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN and GH_TOKEN are consulted in that order.',
      toolsets: 'Toolsets',
      toolsetsHint: 'Comma separated. default = the upstream default set (86 tools); all = every tool (131).',
      readOnly: 'Read-only',
      readOnlyHint: 'Register only the tools the upstream server marks read-only.',
      deferLoading: 'Defer tool definitions',
      deferLoadingHint: 'Let the harness load the definitions on demand to save context.',
      advanced: 'Advanced',
      host: 'GitHub host',
      hostHint: 'github.com, or a GitHub Enterprise hostname.',
      apiBaseUrl: 'REST base URL',
      apiBaseUrlHint: 'Empty derives it from the host.',
      graphqlUrl: 'GraphQL endpoint',
      graphqlUrlHint: 'Empty derives it from the host.',
      timeoutMs: 'Request timeout (ms)',
      retries: 'Retries (429/5xx)',
      maxItems: 'Pagination item cap',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      failed: 'Save failed: a higher-priority configuration may override it, or it is not writable',
      dirty: 'Unsaved changes',
      reset: 'Discard changes',
      loading: 'Reading the configuration…',
      unavailable: 'This DSH serves no configuration scope for the plugin (configForms).',
      notWritable: 'The configuration is not writable (a higher-priority patch layer provides it).',
    }

    // ---------------------------------------------------------------- styles

    // Theme tokens with neutral fallbacks: an unknown token must not make text
    // invisible, and the page follows the active light/dark theme.
    const LABEL = 'var(--dsw-alias-label-primary, inherit)'
    const HINT = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.25))'
    const WARN = 'var(--dsw-alias-state-warn-label, #b45309)'
    const OK = 'var(--dsw-alias-state-success-label, #15803d)'
    const FIELD_BG = 'var(--dsw-alias-markdown-code-block, rgba(127,127,127,0.08))'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    const PAGE = { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '720px', padding: '4px 2px 24px', color: LABEL }
    const ROW = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const LABEL_STYLE = { fontSize: '13px', fontWeight: 600, color: LABEL }
    const HINT_STYLE = { fontSize: '12px', lineHeight: '1.5', color: HINT }
    const INPUT_STYLE = {
      boxSizing: 'border-box',
      width: '100%',
      padding: '6px 8px',
      fontSize: '13px',
      fontFamily: 'inherit',
      color: LABEL,
      background: FIELD_BG,
      border: '1px solid ' + BORDER,
      borderRadius: RADIUS,
    }
    const SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '4px' }
    const LEGEND_STYLE = { fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: HINT }
    const BUTTON_STYLE = {
      alignSelf: 'flex-start',
      padding: '6px 14px',
      fontSize: '13px',
      fontFamily: 'inherit',
      color: LABEL,
      background: FIELD_BG,
      border: '1px solid ' + BORDER,
      borderRadius: RADIUS,
      cursor: 'pointer',
    }
    const CHECK_ROW = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: LABEL }

    // ------------------------------------------------------- configuration

    /**
     * The editable fields, in render order. `path` addresses the value inside this
     * plugin's configuration object (settings ops are path-addressed, so a nested
     * section is an array, not a string).
     */
    const FIELDS = [
      { key: 'token', path: ['token'], kind: 'secret', label: 'token', hint: 'tokenHint' },
      { key: 'toolsets', path: ['toolsets'], kind: 'list', label: 'toolsets', hint: 'toolsetsHint' },
      { key: 'readOnly', path: ['readOnly'], kind: 'switch', label: 'readOnly', hint: 'readOnlyHint' },
      { key: 'deferLoading', path: ['deferLoading'], kind: 'switch', label: 'deferLoading', hint: 'deferLoadingHint' },
    ]

    /** The advanced fields, in the same page but visually separated. */
    const ADVANCED = [
      { key: 'host', path: ['host'], kind: 'text', label: 'host', hint: 'hostHint' },
      { key: 'apiBaseUrl', path: ['apiBaseUrl'], kind: 'text', label: 'apiBaseUrl', hint: 'apiBaseUrlHint' },
      { key: 'graphqlUrl', path: ['graphqlUrl'], kind: 'text', label: 'graphqlUrl', hint: 'graphqlUrlHint' },
      { key: 'timeoutMs', path: ['timeoutMs'], kind: 'number', label: 'timeoutMs' },
      { key: 'retries', path: ['retries'], kind: 'number', label: 'retries' },
      { key: 'maxItems', path: ['maxItems'], kind: 'number', label: 'maxItems' },
    ]

    const PENDING_SNAPSHOT = { status: 'pending', value: undefined, writable: false, revision: undefined }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable', value: undefined, writable: false, revision: undefined }

    /** Read a path out of the configuration object. */
    function readPath(value, path) {
      let node = value
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    /**
     * Everything the page knows about the Host configuration.
     *
     * Both the service and the row are optional, so every read is tolerant: a
     * missing `configForms`, a row this Host does not serve, and a scope whose
     * `getSnapshot` throws all end at `unavailable` instead of an exception in the
     * middle of a render.
     */
    function createConfigModel() {
      let served = false
      let scope
      let unsubscribe
      let cached
      const listeners = new Set()

      const publish = () => {
        // Copy first: a listener may unsubscribe itself while being notified.
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-github-tools: a settings listener failed', error)
          }
        }
      }

      const read = () => {
        if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') {
          return served ? PENDING_SNAPSHOT : UNAVAILABLE_SNAPSHOT
        }
        let next
        try {
          next = scope.getSnapshot()
        } catch (error) {
          console.error('dsh-github-tools: reading the configuration scope failed', error)
          return UNAVAILABLE_SNAPSHOT
        }
        if (next === null || typeof next !== 'object') return UNAVAILABLE_SNAPSHOT
        // `useSyncExternalStore` compares snapshots by identity, so one object per
        // revision is returned instead of a fresh copy on every read.
        if (cached === undefined || cached.revision !== next.revision || cached.status !== next.status) cached = next
        return cached
      }

      return {
        /** Record that the service exists, before any scope is available. */
        noteService: () => {
          served = true
        },
        /** Bind the scope once the Host lists the namespace. */
        attach: (next) => {
          if (next === undefined || next === null) return
          served = true
          scope = next
          if (typeof scope.subscribe === 'function') {
            try {
              unsubscribe = scope.subscribe(publish)
            } catch (error) {
              console.error('dsh-github-tools: subscribing to the configuration scope failed', error)
            }
          }
          publish()
        },
        /** Release the scope subscription; the caller's effect owns the call. */
        detach: () => {
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch (error) {
              console.error('dsh-github-tools: releasing the configuration scope failed', error)
            }
          }
          unsubscribe = undefined
        },
        read,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Submit exactly one path-addressed write against the revision read just
         * now, and answer whether the Host accepted it.
         *
         * The revision matters: the settings service refuses a write composed
         * against a value somebody else has already replaced rather than silently
         * overwriting it.
         */
        write: async (ops) => {
          const snapshot = read()
          if (scope === undefined || typeof scope.mutate !== 'function') return false
          if (snapshot.writable !== true) return false
          const batch = Array.isArray(ops) ? ops : [ops]
          if (batch.length === 0) return true
          try {
            const landed = await scope.mutate(batch, snapshot.revision)
            return Boolean(landed)
          } catch (error) {
            console.error('dsh-github-tools: writing the configuration failed', error)
            return false
          }
        },
      }
    }

    // ------------------------------------------------------------ rendering

    /** Stand-in model for a seat that renders without injected props. */
    const DETACHED_MODEL = createConfigModel()

    /** Turn a stored value into the text shown in an input. */
    function toDraft(field, stored) {
      if (field.kind === 'switch') return stored === true
      if (stored === undefined || stored === null) return ''
      if (field.kind === 'list') return Array.isArray(stored) ? stored.join(', ') : String(stored)
      return String(stored)
    }

    /** Turn a draft back into the value written to the configuration. */
    function fromDraft(field, draft) {
      if (field.kind === 'switch') return draft === true
      const text = typeof draft === 'string' ? draft.trim() : ''
      if (field.kind === 'list') {
        return text === '' ? [] : text.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
      }
      if (field.kind === 'number') {
        const parsed = Number(text)
        return Number.isFinite(parsed) ? parsed : undefined
      }
      return text
    }

    function sameValue(left, right) {
      if (Array.isArray(left) || Array.isArray(right)) {
        const a = Array.isArray(left) ? left : []
        const b = Array.isArray(right) ? right : []
        return a.length === b.length && a.every((entry, index) => entry === b[index])
      }
      return left === right
    }

    function fieldNode(field, draft, onChange, t, disabled) {
      const label = t(field.label)
      if (field.kind === 'switch') {
        return React.createElement('label', { key: field.key, style: CHECK_ROW },
          React.createElement('input', {
            type: 'checkbox',
            checked: draft === true,
            disabled,
            onChange: (event) => onChange(event.target.checked),
          }),
          React.createElement('span', null, label),
          field.hint === undefined ? null : React.createElement('span', { style: HINT_STYLE }, ' · ' + t(field.hint)),
        )
      }
      return React.createElement('div', { key: field.key, style: ROW },
        React.createElement('label', { style: LABEL_STYLE, htmlFor: 'gh-' + field.key }, label),
        React.createElement('input', {
          id: 'gh-' + field.key,
          type: field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text',
          style: INPUT_STYLE,
          value: typeof draft === 'string' ? draft : '',
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event) => onChange(event.target.value),
        }),
        field.hint === undefined ? null : React.createElement('span', { style: HINT_STYLE }, t(field.hint)),
      )
    }

    /** The row's configuration page, and its one-line summary. */
    function RowConfig(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      // A seat that somehow renders without injected props must show the
      // "not served" note instead of throwing mid-render.
      const model = props.model === undefined || props.model === null ? DETACHED_MODEL : props.model
      const snapshot = React.useSyncExternalStore(model.subscribe, model.read, model.read)
      const revision = snapshot === undefined ? undefined : snapshot.revision
      const [draft, setDraft] = React.useState(null)
      const [state, setState] = React.useState('idle')

      // A new revision from the Host discards the local draft: the Host's value is
      // the truth, and a stale draft would silently overwrite somebody else's edit.
      React.useEffect(() => {
        setDraft(null)
        setState('idle')
      }, [revision])

      if (props.view === 'summary') return React.createElement('span', null, t('summary'))

      if (snapshot.status === 'unavailable') {
        return React.createElement('div', { style: PAGE }, React.createElement('p', { style: HINT_STYLE }, t('unavailable')))
      }
      if (snapshot.status !== 'ready') {
        return React.createElement('div', { style: PAGE }, React.createElement('p', { style: HINT_STYLE }, t('loading')))
      }

      const base = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const writable = snapshot.writable === true
      const fields = FIELDS.concat(ADVANCED)
      const current = {}
      let dirty = false
      for (const field of fields) {
        const stored = readPath(base, field.path)
        const value = draft !== null && Object.hasOwn(draft, field.key) ? draft[field.key] : toDraft(field, stored)
        current[field.key] = value
        if (!sameValue(fromDraft(field, value), stored)) dirty = true
      }

      const setField = (field, value) => {
        const next = Object.assign({}, current)
        next[field.key] = value
        setDraft(next)
        setState('idle')
      }

      const save = async () => {
        setState('saving')
        const ops = []
        for (const field of fields) {
          const stored = readPath(base, field.path)
          const next = fromDraft(field, current[field.key])
          if (next === undefined || sameValue(next, stored)) continue
          ops.push({ op: 'set', path: field.path, value: next })
        }
        const landed = await model.write(ops)
        if (landed) {
          setDraft(null)
          setState('saved')
        } else {
          setState('failed')
        }
      }

      const status = state === 'saving'
        ? t('saving')
        : state === 'saved'
          ? t('saved')
          : state === 'failed'
            ? t('failed')
            : dirty
              ? t('dirty')
              : ''

      return React.createElement('div', { style: PAGE },
        React.createElement('p', { style: HINT_STYLE }, t('intro')),
        React.createElement('div', { style: SECTION_STYLE },
          FIELDS.map((field) => fieldNode(field, current[field.key], (value) => setField(field, value), t, !writable)),
        ),
        React.createElement('div', { style: SECTION_STYLE },
          React.createElement('span', { style: LEGEND_STYLE }, t('advanced')),
          ADVANCED.map((field) => fieldNode(field, current[field.key], (value) => setField(field, value), t, !writable)),
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          React.createElement('button', {
            type: 'button',
            style: BUTTON_STYLE,
            disabled: !writable || !dirty || state === 'saving',
            onClick: save,
          }, t('save')),
          dirty
            ? React.createElement('button', {
              type: 'button',
              style: BUTTON_STYLE,
              disabled: state === 'saving',
              onClick: () => {
                setDraft(null)
                setState('idle')
              },
            }, t('reset'))
            : null,
          status === ''
            ? null
            : React.createElement('span', {
              style: state === 'failed'
                ? Object.assign({}, HINT_STYLE, { color: WARN })
                : state === 'saved'
                  ? Object.assign({}, HINT_STYLE, { color: OK })
                  : HINT_STYLE,
            }, status),
        ),
        writable ? null : React.createElement('p', { style: Object.assign({}, HINT_STYLE, { color: WARN }) }, t('notWritable')),
      )
    }

    // ---------------------------------------------------------------- apply

    /**
     * Mount the row configuration page.
     *
     * This function must never throw: a client half that fails to apply takes its
     * whole bundle's browser surface down with it, and the GitHub tools work fine
     * without any of this. So a missing `slots` service, a missing `configForms`,
     * an unserved configuration row and a scope that refuses to be read all
     * degrade into a note on the page instead of an exception.
     */
    function apply(ctx) {
      const model = createConfigModel()

      try {
        if (ctx.locale !== undefined && ctx.locale !== null && typeof ctx.locale.register === 'function') {
          const off = ctx.locale.register(NS, { zh, en })
          if (typeof ctx.effect === 'function') ctx.effect(() => off, 'dsh-github-tools: copy dictionaries')
        }
      } catch (error) {
        console.error('dsh-github-tools: registering the copy dictionaries failed', error)
      }

      // `configForms` is reached through `ctx.inject`, never through this module's
      // own `inject` array: the page is a convenience, not a reason to refuse to
      // mount on a composition that does not ship the settings service.
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (inner) => {
            const configForms = inner.configForms
            if (configForms === undefined || configForms === null) return
            model.noteService()
            const attach = (scope) => {
              try {
                model.attach(scope)
              } catch (error) {
                console.error('dsh-github-tools: reading the "' + CONFIG_ROW_ID + '" configuration scope failed', error)
              }
            }
            // A form fetched before the Host's `describe()` round trip settles is
            // born with its persistence fixed to "not host" and never upgrades, so
            // the namespace is awaited through the platform's own gate.
            let stop
            if (typeof configForms.whileServed === 'function') {
              stop = configForms.whileServed([CONFIG_ROW_ID], () => {
                attach(configForms.get(CONFIG_ROW_ID))
                return () => model.detach()
              })
            } else {
              attach(configForms.get(CONFIG_ROW_ID))
              stop = () => model.detach()
            }
            if (typeof inner.effect === 'function') inner.effect(() => stop, 'dsh-github-tools: configuration scope')
          })
        }
      } catch (error) {
        console.error('dsh-github-tools: asking for the configuration service failed', error)
      }

      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('dsh-github-tools: this DSH has no slots service; the configuration page stays unmounted')
          return
        }
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: SLOT_KEY,
          locale: NS,
          inject: () => ({ model }),
        }, RowConfig))
      } catch (error) {
        console.error('dsh-github-tools: registering the row configuration page failed', error)
      }
    }

    // `slots` is the one service this module needs before it can do anything.
    // `configForms` and `locale` are optional and are asked for above, at runtime.
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-github-tools'
    return module.exports
  },
})
