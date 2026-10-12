// dsh-github-tools, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page loads
// it as a script, the module loader below hands it a `require`, and the modules it
// asks for are React and the client UI primitives.
//
// What it contributes:
//   - the row configuration page on the Plugins page, registered into
//     `plugins.row.config` under the key `<package name>#<row id>` that
//     ui-plugin-manager's `rowConfigKey` builds, and
//   - a tab in Settings -> Plugins (`settings.plugins.tab`) showing the same form,
//     for people who look for plugin settings in Settings rather than in the row.
//
// The form itself is the platform's own: `SettingsFormModel` stages the drafts,
// `SettingsForm` draws the frame and its single Save, and `SettingsValueField` /
// `SettingsSecretField` draw the controls. Nothing here invents a transport: the
// scope comes from `configForms`, addressed by the Loader ROW id (not the package
// name — one package may be composed as several rows).

window.__ModuleLoader__.load({
  id: 'dsh-github-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const SettingsForm = primitives.SettingsForm
    const SettingsFormModel = primitives.SettingsFormModel
    const SettingsValueField = primitives.SettingsValueField
    const SettingsSecretField = primitives.SettingsSecretField
    const Switch = primitives.Switch
    const settingsTextField = primitives.settingsTextField
    const settingsNumberField = primitives.settingsNumberField

    /** Locale namespace for this plugin's copy. */
    const NS = 'dsh-github-tools'

    /**
     * Loader row id of this bundle's Host half, read from our own
     * `cordis.patch.yml`. `configForms.get` addresses a Host configuration entry by
     * that row id.
     */
    const CONFIG_ROW_ID = 'github-tools'

    /**
     * GitHub's classic-token form, pre-filled with the scopes this tool set uses and a
     * recognisable description, so creating the credential is one click from the field.
     */
    const TOKEN_CREATE_URL = 'https://github.com/settings/tokens/new'
      + '?description=DeepSeek%20Harness%20GitHub%20tools'
      + '&scopes=repo,workflow,gist,read:org,read:user,user:email,notifications,read:packages'

    /** The link colour, read as a theme token so it follows light/dark. */
    const LINK = 'var(--dsw-alias-link, inherit)'

    /** The `plugins.row.config` key: `<package name>#<row id>`. */
    const SLOT_KEY = 'dsh-github-tools#github-tools'

    // ------------------------------------------------------------------ copy

    const zh = {
      tabLabel: 'GitHub 工具',
      title: 'GitHub 工具',
      summary: '令牌、toolset 与只读开关',
      intro: '这些设置写入本插件的配置行，保存后立即生效：工具集会实时重新注册，不需要重启 DSH。',
      sectionConnection: '连接',
      sectionTools: '工具集',
      sectionAdvanced: '高级',
      token: 'Personal Access Token',
      tokenHint: '留空即不修改已保存的令牌；未配置时依次回退到环境变量 GITHUB_PERSONAL_ACCESS_TOKEN、GITHUB_TOKEN、GH_TOKEN。',
      tokenCreate: '去 GitHub 创建 token ↗',
      tokenConfigured: '已配置',
      tokenMissing: '未配置',
      toolsets: 'Toolset',
      toolsetsHint: '逗号分隔。default = 上游默认的 6 个 toolset（86 个工具）；all = 全部 131 个。',
      tools: '指定工具',
      toolsHint: '逗号分隔的工具名；非空时完全取代上面的 toolset 选择。',
      excludeTools: '排除工具',
      excludeToolsHint: '逗号分隔；从最终选择里移除。',
      readOnly: '只读模式',
      readOnlyHint: '只注册上游标记为只读的工具，写操作全部隐藏。',
      deferLoading: '延迟加载工具定义',
      deferLoadingHint: '让宿主按需加载工具定义，减少上下文占用。',
      host: 'GitHub 主机',
      hostHint: 'github.com，或 GitHub Enterprise 的主机名。',
      apiBaseUrl: 'REST 基址',
      apiBaseUrlHint: '留空按 host 自动推导。',
      graphqlUrl: 'GraphQL 端点',
      graphqlUrlHint: '留空按 host 自动推导。',
      timeoutMs: '单次请求超时（毫秒）',
      retries: '重试次数（429/5xx）',
      maxItems: '单次分页条目上限',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalid: '请填有效值；留空表示使用默认值。',
      unavailable: '当前 DSH 没有为该插件提供配置作用域（configForms），无法在此调整。',
      readOnlyDeployment: '本部署的设置为只读。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
    }

    const en = {
      tabLabel: 'GitHub tools',
      title: 'GitHub tools',
      summary: 'Token, toolsets and the read-only switch',
      intro: 'These settings are written to this plugin’s configuration row and apply immediately: the tool set is re-registered live, with no DSH restart.',
      sectionConnection: 'Connection',
      sectionTools: 'Toolsets',
      sectionAdvanced: 'Advanced',
      token: 'Personal access token',
      tokenHint: 'Leave blank to keep the stored token; when none is configured, GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_TOKEN and GH_TOKEN are consulted in that order.',
      tokenCreate: 'Create a token on GitHub ↗',
      tokenConfigured: 'Configured',
      tokenMissing: 'Not set',
      toolsets: 'Toolsets',
      toolsetsHint: 'Comma separated. default = the upstream default set (86 tools); all = every tool (131).',
      tools: 'Explicit tools',
      toolsHint: 'Comma separated tool names; when non-empty this replaces the toolset selection entirely.',
      excludeTools: 'Excluded tools',
      excludeToolsHint: 'Comma separated; removed from the final selection.',
      readOnly: 'Read-only',
      readOnlyHint: 'Register only the tools the upstream server marks read-only.',
      deferLoading: 'Defer tool definitions',
      deferLoadingHint: 'Let the harness load the definitions on demand to save context.',
      host: 'GitHub host',
      hostHint: 'github.com, or a GitHub Enterprise hostname.',
      apiBaseUrl: 'REST base URL',
      apiBaseUrlHint: 'Empty derives it from the host.',
      graphqlUrl: 'GraphQL endpoint',
      graphqlUrlHint: 'Empty derives it from the host.',
      timeoutMs: 'Request timeout (ms)',
      retries: 'Retries (429/5xx)',
      maxItems: 'Pagination item cap',
      overridden: 'Overridden',
      reset: 'Reset to default',
      invalid: 'Enter a valid value; leave blank to use the default.',
      unavailable: 'This DSH serves no configuration scope for the plugin (configForms).',
      readOnlyDeployment: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      save: 'Save',
      saving: 'Saving…',
    }

    /** The labels the shared form frame renders. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnlyDeployment'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    // ------------------------------------------------------------ field specs

    /**
     * A boolean field. The shared model stages text, so the switch writes the two
     * strings its own `parse` accepts.
     */
    function booleanSpec(field) {
      return {
        field,
        format: (value) => (value === true ? 'true' : 'false'),
        parse: (text) => (text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined),
      }
    }

    /** A comma-separated list field; an empty draft clears the override. */
    function listSpec(field) {
      return {
        field,
        format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          return { kind: 'set', value: trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '') }
        },
      }
    }

    /** Which control each field renders as. */
    const BOOLEAN_FIELDS = ['readOnly', 'deferLoading']
    const LIST_FIELDS = ['toolsets', 'tools', 'excludeTools']
    const TEXT_FIELDS = ['host', 'apiBaseUrl', 'graphqlUrl']
    const NUMBER_FIELDS = ['timeoutMs', 'retries', 'maxItems']
    const SECRET_FIELDS = ['token']

    /** The sections the page draws, in order. */
    const SECTIONS = [
      { id: 'connection', label: 'sectionConnection', fields: ['token', 'host', 'apiBaseUrl', 'graphqlUrl'] },
      { id: 'tools', label: 'sectionTools', fields: ['toolsets', 'tools', 'excludeTools', 'readOnly', 'deferLoading'] },
      { id: 'advanced', label: 'sectionAdvanced', fields: ['timeoutMs', 'retries', 'maxItems'] },
    ]

    const ALL_FIELDS = SECRET_FIELDS.concat(TEXT_FIELDS, NUMBER_FIELDS, BOOLEAN_FIELDS, LIST_FIELDS)

    const SPECS = []
      .concat(
        TEXT_FIELDS.map((field) => settingsTextField(field)),
        NUMBER_FIELDS.map((field) => settingsNumberField(field)),
        BOOLEAN_FIELDS.map((field) => booleanSpec(field)),
        LIST_FIELDS.map((field) => listSpec(field)),
      )

    // ---------------------------------------------------------------- styles

    // Theme tokens with neutral fallbacks: an unknown token must not make text
    // invisible, and the page follows the active light/dark theme.
    const LABEL = 'var(--dsw-alias-label-primary, inherit)'
    const HINT = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.25))'

    const PAGE = { display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '720px', color: LABEL }
    const INTRO = { margin: 0, fontSize: '12px', lineHeight: '1.6', color: HINT }
    const SECTION = { display: 'flex', flexDirection: 'column', gap: '14px', paddingTop: '16px', borderTop: '1px solid ' + BORDER }
    const LEGEND = { fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: HINT }
    const SWITCH_ROW = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }
    const SWITCH_TEXT = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
    const SWITCH_LABEL = { fontSize: '13px', fontWeight: 600, color: LABEL }
    const SWITCH_HINT = { fontSize: '12px', lineHeight: '1.5', color: HINT }

    // ------------------------------------------------------------- rendering

    /** One boolean row: the platform's Switch, with the same label/hint shape. */
    function BooleanRow(props) {
      const field = props.field
      return React.createElement('div', { style: SWITCH_ROW },
        React.createElement('div', { style: SWITCH_TEXT },
          React.createElement('span', { style: SWITCH_LABEL }, props.t(field)),
          React.createElement('span', { style: SWITCH_HINT }, props.t(field + 'Hint')),
        ),
        React.createElement(Switch, {
          checked: props.state.text === 'true',
          disabled: props.disabled,
          label: props.t(field),
          onChange: (next) => props.onEdit(next ? 'true' : 'false'),
        }),
      )
    }

    /** One text/number/list row: the platform's staged value field. */
    function ValueRow(props) {
      const field = props.field
      return React.createElement(SettingsValueField, {
        id: 'gh-' + field,
        label: props.t(field),
        hint: props.t(field + 'Hint'),
        overriddenLabel: props.t('overridden'),
        resetLabel: props.t('reset'),
        invalidLabel: props.t('invalid'),
        numeric: NUMBER_FIELDS.includes(field),
        disabled: props.disabled,
        text: props.state.text,
        overridden: props.state.overridden,
        invalid: props.state.invalid,
        onEdit: props.onEdit,
        onReset: props.onReset,
      })
    }

    /** The plugin's whole configuration form, shared by both surfaces. */
    function ConfigForm(props) {
      const t = props.t
      const state = props.useForm((snapshot) => snapshot)
      const disabled = state.writable !== true
      const children = [React.createElement('p', { key: 'intro', style: INTRO }, t('intro'))]
      for (const section of SECTIONS) {
        const rows = []
        for (const field of section.fields) {
          const fieldState = state[field] === undefined ? { text: '', overridden: false, invalid: false } : state[field]
          if (field === 'token') {
            rows.push(React.createElement(SettingsSecretField, {
              key: field,
              id: 'gh-' + field,
              label: t(field),
              hint: React.createElement(React.Fragment, null,
                t(field + 'Hint'),
                ' ',
                React.createElement('a', {
                  href: TOKEN_CREATE_URL,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  style: { color: LINK, textDecoration: 'underline' },
                }, t('tokenCreate')),
              ),
              configured: state.tokenConfigured === true,
              stateLabel: state.tokenConfigured === true ? t('tokenConfigured') : t('tokenMissing'),
              text: fieldState.text,
              disabled,
              onEdit: (text) => props.edit(field, text),
            }))
          } else if (BOOLEAN_FIELDS.includes(field)) {
            rows.push(React.createElement(BooleanRow, {
              key: field,
              field,
              t,
              state: fieldState,
              disabled,
              onEdit: (text) => props.edit(field, text),
            }))
          } else {
            rows.push(React.createElement(ValueRow, {
              key: field,
              field,
              t,
              state: fieldState,
              disabled,
              onEdit: (text) => props.edit(field, text),
              onReset: () => props.resetField(field),
            }))
          }
        }
        children.push(React.createElement('div', { key: section.id, style: SECTION },
          React.createElement('span', { style: LEGEND }, t(section.label)),
          ...rows,
        ))
      }
      return React.createElement(SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      }, ...children)
    }

    /** The row's page on the Plugins page, and its one-line summary. */
    function RowConfig(props) {
      const t = props.t
      if (props.view === 'summary') return t('summary')
      return React.createElement(ConfigForm, props)
    }

    /** The Settings -> Plugins tab: the same form under its own heading. */
    function SettingsPanel(props) {
      const t = props.t
      return React.createElement('div', { style: PAGE },
        React.createElement('h2', { style: { margin: 0, fontSize: '15px', fontWeight: 600, color: LABEL } }, t('title')),
        React.createElement(ConfigForm, props),
      )
    }

    // ---------------------------------------------------------------- apply

    /**
     * Mount the configuration surfaces.
     *
     * This function must never throw: a client half that fails to apply takes its
     * whole bundle's browser surface down with it, and the GitHub tools work fine
     * without any of this. The shared form reports a namespace that never arrives as
     * `available: false`, so there is nothing to guard beyond the services.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-github-tools: copy dictionaries')

      const scope = ctx.configForms.get(CONFIG_ROW_ID)

      // The token is a write-only control: it is never echoed back, and a blank draft
      // writes nothing, so saving the rest of the form keeps the stored token.
      const secrets = SECRET_FIELDS.map((field) => ({
        field,
        write: async (value) => {
          const snapshot = scope.getSnapshot()
          const landed = await scope.mutate([{ op: 'set', path: [field], value }], snapshot.revision)
          return Boolean(landed)
        },
      }))

      const form = new SettingsFormModel(scope, SPECS, secrets)

      /**
       * The face both surfaces render: the frame's state, one entry per control, and
       * whether a token is stored.
       */
      const projection = () => {
        const state = Object.assign({}, form.shell())
        for (const field of ALL_FIELDS) state[field] = form.field(field)
        const snapshot = scope.getSnapshot()
        const value = snapshot !== null && typeof snapshot === 'object' && snapshot.value !== null && typeof snapshot.value === 'object'
          ? snapshot.value
          : {}
        state.tokenConfigured = typeof value.token === 'string' && value.token.length > 0
        return state
      }

      const store = form.bind(projection)
      const face = () => Object.assign({ hooks: { form: store } }, form.actions())

      ctx.effect(() => () => form.dispose(), 'dsh-github-tools: form subscription')

      // The row page: the Plugins page gives the row a Configure control while this
      // registration names it, and the registration lives while the bundle is on.
      ctx.effect(() => ctx.configForms.whileServed([CONFIG_ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: SLOT_KEY,
        locale: NS,
        inject: () => Object.assign({ t }, face()),
      }, RowConfig))), 'dsh-github-tools: row configuration page')

      // And the same form as a tab in Settings -> Plugins, for readers who look for
      // plugin settings there instead of in the plugin's row.
      ctx.effect(() => ctx.configForms.whileServed([CONFIG_ROW_ID], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: NS,
        order: 60,
        label: () => t('tabLabel'),
        locale: NS,
        inject: () => Object.assign({ t }, face()),
      }, SettingsPanel))), 'dsh-github-tools: settings tab')

      // The Settings panel's own navigation entry, beside the shipped sections and
      // dsh-market's page. The row page above is where a plugin's configuration lives
      // on the Plugins page; this is where someone who looks in Settings finds it.
      ctx.effect(() => ctx.configForms.whileServed([CONFIG_ROW_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 65,
        label: () => t('title'),
        locale: NS,
        inject: () => Object.assign({ t }, face()),
      }, SettingsPanel))), 'dsh-github-tools: settings section')
    }

    // `slots`, `locale` and `configForms` are all required before this half can do
    // anything: the page, its copy and its transport each come from one of them.
    const inject = ['slots', 'locale', 'configForms']

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-github-tools'
    return module.exports
  },
})
