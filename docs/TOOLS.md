# Tool inventory

All 131 tools, grouped by toolset. Generated from `github/github-mcp-server`
(`pkg/github/__toolsnaps__`) — regenerate with `node scripts/generate.mjs`.

"read-only" is the upstream `readOnlyHint` annotation: with `readOnly: true` in the plugin
config only those tools are registered.

| tool | toolset | read-only | upstream source | description |
| --- | --- | :---: | --- | --- |
| `actions_get` | `actions` | yes | `pkg/github/actions.go` · `ActionsGet` | Get details about specific GitHub Actions resources. Use this tool to get details about individual workflows, workflow … |
| `actions_list` | `actions` | yes | `pkg/github/actions.go` · `ActionsList` | Tools for listing GitHub Actions resources. Use this tool to list workflows in a repository, or list workflow runs, job… |
| `actions_run_trigger` | `actions` | — | `pkg/github/actions.go` · `ActionsRunTrigger` | Trigger GitHub Actions workflow operations, including running, re-running, cancelling workflow runs, and deleting workf… |
| `get_job_logs` | `actions` | yes | `pkg/github/actions.go` · `ActionsGetJobLogs` | Get logs for GitHub Actions workflow jobs. Use this tool to retrieve logs for a specific job or all failed jobs in a wo… |
| `get_code_quality_finding` | `code_quality` | yes | `pkg/github/code_quality.go` · `GetCodeQualityFinding` | Get details of a specific code quality finding in a GitHub repository. |
| `get_code_scanning_alert` | `code_security` | yes | `pkg/github/code_scanning.go` · `GetCodeScanningAlert` | Get details of a specific code scanning alert in a GitHub repository. |
| `list_code_scanning_alerts` | `code_security` | yes | `pkg/github/code_scanning.go` · `ListCodeScanningAlerts` | List code scanning alerts in a GitHub repository. |
| `get_me` | `context` | yes | `pkg/github/context_tools.go` · `GetMe` | Get details of the authenticated GitHub user. Use this when a request is about the user's own profile for GitHub. Or wh… |
| `get_team_members` | `context` | yes | `pkg/github/context_tools.go` · `GetTeamMembers` | Get member usernames of a specific team in an organization. Limited to organizations accessible with current credentials |
| `get_teams` | `context` | yes | `pkg/github/context_tools.go` · `GetTeams` | Get details of the teams the user is a member of. Limited to organizations accessible with current credentials |
| `ui_get` | `context` | yes | `pkg/github/ui_tools.go` · `UIGet` | Fetch UI data for MCP Apps (labels, assignees, milestones, issue types, branches, issue fields, reviewers). |
| `assign_copilot_to_issue` | `copilot` | — | `pkg/github/copilot.go` · `AssignCopilotToIssue` | Assign Copilot to a specific issue in a GitHub repository. This tool can help with the following outcomes: - a Pull Req… |
| `request_copilot_review` | `copilot` | — | `pkg/github/copilot.go` · `RequestCopilotReview` | Request a GitHub Copilot code review for a pull request. Use this for automated feedback on pull requests, usually befo… |
| `assign_copilot_to_issue_with_intent` | `copilot_issue_intents` | — | `pkg/github/copilot.go` · `AssignCopilotToIssueWithIntent` | Assign Copilot to a specific issue in a GitHub repository. Prefer this tool over assign_copilot_to_issue when available… |
| `get_dependabot_alert` | `dependabot` | yes | `pkg/github/dependabot.go` · `GetDependabotAlert` | Get details of a specific dependabot alert in a GitHub repository. |
| `list_dependabot_alerts` | `dependabot` | yes | `pkg/github/dependabot.go` · `ListDependabotAlerts` | List dependabot alerts in a GitHub repository. |
| `discussion_comment_write` | `discussions` | — | `pkg/github/discussions.go` · `DiscussionCommentWrite` | Write operations for discussion comments. Supports adding top-level comments, replying to existing comments, updating c… |
| `get_discussion` | `discussions` | yes | `pkg/github/discussions.go` · `GetDiscussion` | Get a specific discussion by ID |
| `get_discussion_comments` | `discussions` | yes | `pkg/github/discussions.go` · `GetDiscussionComments` | Get comments from a discussion |
| `list_discussion_categories` | `discussions` | yes | `pkg/github/discussions.go` · `ListDiscussionCategories` | List discussion categories with their id and name, for a repository or organisation. |
| `list_discussions` | `discussions` | yes | `pkg/github/discussions.go` · `ListDiscussions` | List discussions for a repository or organisation. |
| `create_gist` | `gists` | — | `pkg/github/gists.go` · `CreateGist` | Create a new gist |
| `get_gist` | `gists` | yes | `pkg/github/gists.go` · `GetGist` | Get gist content of a particular gist, by gist ID |
| `list_gists` | `gists` | yes | `pkg/github/gists.go` · `ListGists` | List gists for a user |
| `update_gist` | `gists` | — | `pkg/github/gists.go` · `UpdateGist` | Update an existing gist |
| `get_repository_tree` | `git` | yes | `pkg/github/git.go` · `GetRepositoryTree` | Get the tree structure (files and directories) of a GitHub repository at a specific ref or SHA |
| `create_repository_ruleset` | `governance` | — | `pkg/github/rulesets.go` · `createRepositoryRulesetLegacy` | Create a new ruleset at the repository, organization, or enterprise level |
| `custom_properties_read` | `governance` | yes | `pkg/github/custom_properties.go` · `customPropertiesReadLegacy` | Read custom properties at the repository, organization, or enterprise level. At the repository level this returns the p… |
| `custom_properties_write` | `governance` | — | `pkg/github/custom_properties.go` · `customPropertiesWriteLegacy` | Create or update custom properties at the repository, organization, or enterprise level. At the repository level this s… |
| `repository_ruleset_read` | `governance` | yes | `pkg/github/rulesets.go` · `repositoryRulesetReadLegacy` | Read rulesets at the repository, organization, or enterprise level, and rule suites at the repository or organization l… |
| `add_issue_comment` | `issues` | — | `pkg/github/issues.go` · `AddIssueComment` | Add a comment and/or reaction to a specific issue or issue comment in a GitHub repository. Use this tool with pull requ… |
| `add_issue_comment_reaction` | `issues` | — | `pkg/github/issues_granular.go` · `GranularAddIssueCommentReaction` | Add a reaction to an issue or pull request comment. |
| `add_issue_reaction` | `issues` | — | `pkg/github/issues_granular.go` · `GranularAddIssueReaction` | Add a reaction to an issue or pull request. |
| `add_sub_issue` | `issues` | — | `pkg/github/issues_granular.go` · `GranularAddSubIssue` | Add a sub-issue to a parent issue. |
| `create_issue` | `issues` | — | `pkg/github/issues_granular.go` · `GranularCreateIssue` | Create a new issue in a GitHub repository with a title and optional body. |
| `find_duplicate` | `issues` | yes | `pkg/github/find_duplicate.go` · `FindDuplicate` | Find likely duplicate issues for an existing issue in a GitHub repository. This is a read-only search scoped to the sou… |
| `get_label` | `issues` | yes | `pkg/github/labels.go` · `getLabelLegacy` | Get a specific label from a repository. |
| `hide_issue_comment` | `issues` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Hide (minimize) a comment on an issue, or a conversation comment on a pull request. Requires triage or write access to … |
| `issue_dependency_read` | `issues` | yes | `pkg/github/issue_dependencies.go` · `IssueDependencyRead` | Read an issue's dependency relationships in a GitHub repository: the issues that block it (blocked_by) or the issues it… |
| `issue_dependency_write` | `issues` | — | `pkg/github/issue_dependencies.go` · `IssueDependencyWrite` | Add or remove an issue dependency relationship in a GitHub repository. Use type 'blocked_by' to record that the subject… |
| `issue_read` | `issues` | yes | `pkg/github/issues.go` · `IssueRead` | Get information about a specific issue in a GitHub repository. |
| `issue_write` | `issues` | — | `pkg/github/issues.go` · `IssueWrite` | Create a new or update an existing issue in a GitHub repository. |
| `list_issue_fields` | `issues` | yes | `pkg/github/issue_fields.go` · `ListIssueFields` | List issue fields for a repository or organization. Returns field definitions including name, type (text, number, date,… |
| `list_issue_types` | `issues` | yes | `pkg/github/issues.go` · `ListIssueTypes` | List supported issue types for a repository or its owner organization. When repo is omitted, returns org-level issue ty… |
| `list_issues` | `issues` | yes | `pkg/github/issues.go` · `ListIssues` | List issues in a GitHub repository. For pagination, use the 'endCursor' from the previous response's 'pageInfo' in the … |
| `remove_issue_comment_reaction` | `issues` | — | `pkg/github/issues_granular.go` · `GranularRemoveIssueCommentReaction` | Remove a reaction from an issue or pull request comment. |
| `remove_issue_reaction` | `issues` | — | `pkg/github/issues_granular.go` · `GranularRemoveIssueReaction` | Remove a reaction from an issue or pull request. |
| `remove_sub_issue` | `issues` | — | `pkg/github/issues_granular.go` · `GranularRemoveSubIssue` | Remove a sub-issue from a parent issue. |
| `reprioritize_sub_issue` | `issues` | — | `pkg/github/issues_granular.go` · `GranularReprioritizeSubIssue` | Reprioritize (reorder) a sub-issue relative to other sub-issues. |
| `search_issues` | `issues` | yes | `pkg/github/issues.go` · `SearchIssues` | Search issues using natural-language semantic matching. Best for conceptual or paraphrased queries (e.g. "login fails a… |
| `set_issue_fields` | `issues` | — | `pkg/github/issues_granular.go` · `GranularSetIssueFields` | Set issue field values for an issue. Fields are organization-level custom fields (text, number, date, or single select)… |
| `sub_issue_write` | `issues` | — | `pkg/github/issues.go` · `SubIssueWrite` | Add a sub-issue to a parent issue in a GitHub repository. |
| `unhide_issue_comment` | `issues` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Unhide (unminimize) a previously hidden comment on an issue, or conversation comment on a pull request. Requires triage… |
| `update_issue_assignees` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueAssignees` | Update the assignees of an existing issue. This replaces the current assignees with the provided list. When setting val… |
| `update_issue_body` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueBody` | Update the body content of an existing issue. |
| `update_issue_comment` | `issues` | — | `pkg/github/issues.go` · `UpdateIssueComment` | Update the body of an existing issue or pull request conversation comment. This tool cannot update pull request review … |
| `update_issue_labels` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueLabels` | Update the labels of an existing issue. This replaces the current labels with the provided list. When setting values, i… |
| `update_issue_milestone` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueMilestone` | Update the milestone of an existing issue. |
| `update_issue_state` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueState` | Update the state of an existing issue (open or closed), with an optional state reason. When closing, include a confiden… |
| `update_issue_title` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueTitle` | Update the title of an existing issue. |
| `update_issue_type` | `issues` | — | `pkg/github/issues_granular.go` · `GranularUpdateIssueType` | Set or remove the type of an existing issue. Pass null to remove the current type. When setting a value, include a conf… |
| `label_write` | `labels` | — | `pkg/github/labels.go` · `labelWriteLegacy` | Perform write operations on repository labels. To set labels on issues, use the 'update_issue' tool. |
| `list_label` | `labels` | yes | `pkg/github/labels.go` · `listLabelsLegacy` | List labels from a repository, ordered by issue count (descending) so the most-used labels are returned first |
| `dismiss_notification` | `notifications` | — | `pkg/github/notifications.go` · `DismissNotification` | Dismiss a notification by marking it as read or done |
| `get_notification_details` | `notifications` | yes | `pkg/github/notifications.go` · `GetNotificationDetails` | Get detailed information for a specific GitHub notification, always call this tool when the user asks for details about… |
| `list_notifications` | `notifications` | yes | `pkg/github/notifications.go` · `ListNotifications` | Lists all GitHub notifications for the authenticated user, including unread notifications, mentions, review requests, a… |
| `manage_notification_subscription` | `notifications` | — | `pkg/github/notifications.go` · `ManageNotificationSubscription` | Manage a notification subscription: ignore, watch, or delete a notification thread subscription. |
| `manage_repository_notification_subscription` | `notifications` | — | `pkg/github/notifications.go` · `ManageRepositoryNotificationSubscription` | Manage a repository notification subscription: ignore, watch, or delete repository notifications subscription for the p… |
| `mark_all_notifications_read` | `notifications` | — | `pkg/github/notifications.go` · `MarkAllNotificationsRead` | Mark all notifications as read |
| `search_orgs` | `orgs` | yes | `pkg/github/search.go` · `SearchOrgs` | Find GitHub organizations by name, location, or other organization metadata. Ideal for discovering companies, open sour… |
| `projects_get` | `projects` | yes | `pkg/github/projects.go` · `ProjectsGet` | Get details about specific GitHub Projects resources. Use this tool to get details about individual projects, project f… |
| `projects_list` | `projects` | yes | `pkg/github/projects.go` · `ProjectsList` | Tools for listing GitHub Projects resources. Use this tool to list projects for a user or organization, or list project… |
| `projects_write` | `projects` | — | `pkg/github/projects.go` · `ProjectsWrite` | Create and manage GitHub Projects: create projects, add/update/delete items, bulk-update many items at once, manage vie… |
| `add_comment_to_pending_review` | `pull_requests` | — | `pkg/github/pullrequests.go` · `AddCommentToPendingReview` | Add review comment to the requester's latest pending pull request review. A pending review needs to already exist to ca… |
| `add_pull_request_review_comment` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularAddPullRequestReviewComment` | Add a review comment to the current user's pending pull request review. |
| `add_pull_request_review_comment_reaction` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularAddPullRequestReviewCommentReaction` | Add a reaction to a pull request review comment. |
| `add_reply_to_pull_request_comment` | `pull_requests` | — | `pkg/github/pullrequests.go` · `AddReplyToPullRequestComment` | Add a reply and/or reaction to an existing pull request comment. This can create a new comment linked as a reply to the… |
| `create_pull_request` | `pull_requests` | — | `pkg/github/pullrequests.go` · `CreatePullRequest` | Create a new pull request in a GitHub repository. |
| `create_pull_request_review` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularCreatePullRequestReview` | Create a review on a pull request. If event is provided, the review is submitted immediately; otherwise a pending revie… |
| `delete_pending_pull_request_review` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularDeletePendingPullRequestReview` | Delete a pending pull request review. |
| `hide_pull_request_review` | `pull_requests` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Hide (minimize) the body of a submitted pull request review. Requires triage or write access to the repository, or bein… |
| `hide_pull_request_review_comment` | `pull_requests` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Hide (minimize) an inline review comment on a pull request diff. Requires triage or write access to the repository, or … |
| `list_pull_requests` | `pull_requests` | yes | `pkg/github/pullrequests.go` · `ListPullRequests` | List pull requests in a GitHub repository. If the user specifies an author, then DO NOT use this tool and use the searc… |
| `merge_pull_request` | `pull_requests` | — | `pkg/github/pullrequests.go` · `MergePullRequest` | Merge a pull request in a GitHub repository. |
| `pull_request_read` | `pull_requests` | yes | `pkg/github/pullrequests.go` · `PullRequestRead` | Get information on a specific pull request in GitHub repository. |
| `pull_request_review_write` | `pull_requests` | — | `pkg/github/pullrequests.go` · `pullRequestReviewWrite` | Create and/or submit, delete review of a pull request. Available methods: - create: Create a new review of a pull reque… |
| `remove_pull_request_review_comment_reaction` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularRemovePullRequestReviewCommentReaction` | Remove a reaction from a pull request review comment. |
| `request_pull_request_reviewers` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularRequestPullRequestReviewers` | Request reviewers for a pull request. |
| `resolve_review_thread` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `granularResolveReviewThread` | Resolve a review thread on a pull request. Resolving an already-resolved thread is a no-op. |
| `search_pull_requests` | `pull_requests` | yes | `pkg/github/pullrequests.go` · `SearchPullRequests` | Search for pull requests in GitHub repositories using issues search syntax already scoped to is:pr |
| `submit_pending_pull_request_review` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularSubmitPendingPullRequestReview` | Submit a pending pull request review. |
| `unhide_pull_request_review` | `pull_requests` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Unhide (unminimize) the previously hidden body of a submitted pull request review. Requires triage or write access to t… |
| `unhide_pull_request_review_comment` | `pull_requests` | — | `pkg/github/comment_minimize.go` · `commentVisibilityTool` | Unhide (unminimize) a previously hidden inline review comment on a pull request diff. Requires triage or write access t… |
| `unresolve_review_thread` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularUnresolveReviewThread` | Unresolve a previously resolved review thread on a pull request. Unresolving an already-unresolved thread is a no-op. |
| `update_pull_request` | `pull_requests` | — | `pkg/github/pullrequests.go` · `UpdatePullRequest` | Update an existing pull request in a GitHub repository. |
| `update_pull_request_body` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularUpdatePullRequestBody` | Update the body description of an existing pull request. |
| `update_pull_request_branch` | `pull_requests` | — | `pkg/github/pullrequests.go` · `UpdatePullRequestBranch` | Update the branch of a pull request with the latest changes from the base branch. |
| `update_pull_request_draft_state` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularUpdatePullRequestDraftState` | Mark a pull request as draft or ready for review. |
| `update_pull_request_state` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularUpdatePullRequestState` | Update the state of an existing pull request (open or closed). |
| `update_pull_request_title` | `pull_requests` | — | `pkg/github/pullrequests_granular.go` · `GranularUpdatePullRequestTitle` | Update the title of an existing pull request. |
| `create_branch` | `repos` | — | `pkg/github/repositories.go` · `CreateBranch` | Create a new branch in a GitHub repository |
| `create_or_update_file` | `repos` | — | `pkg/github/repositories.go` · `CreateOrUpdateFile` | Create or update a single file in a GitHub repository. If updating, you should provide the SHA of the file you want to … |
| `create_repository` | `repos` | — | `pkg/github/repositories.go` · `CreateRepository` | Create a new GitHub repository in your account or specified organization |
| `delete_file` | `repos` | — | `pkg/github/repositories.go` · `DeleteFile` | Delete a file from a GitHub repository |
| `delete_repository` | `repos` | — | `pkg/github/repositories.go` · `DeleteRepository` | Delete a GitHub repository after the user confirms the exact owner/repository name |
| `fork_repository` | `repos` | — | `pkg/github/repositories.go` · `ForkRepository` | Fork a GitHub repository to your account or specified organization |
| `get_commit` | `repos` | yes | `pkg/github/repositories.go` · `GetCommit` | Get details for a commit from a GitHub repository |
| `get_file_blame` | `repos` | yes | `pkg/github/repositories.go` · `GetFileBlame` | Get git blame information for a file, showing the commit that last modified each line. Ranges share commit metadata via… |
| `get_file_contents` | `repos` | yes | `pkg/github/repositories.go` · `GetFileContents` | Get the contents of a file or directory from a GitHub repository |
| `get_latest_release` | `repos` | yes | `pkg/github/repositories.go` · `GetLatestRelease` | Get the latest release in a GitHub repository |
| `get_release_by_tag` | `repos` | yes | `pkg/github/repositories.go` · `GetReleaseByTag` | Get a specific release by its tag name in a GitHub repository |
| `get_tag` | `repos` | yes | `pkg/github/repositories.go` · `GetTag` | Get details about a specific git tag in a GitHub repository |
| `list_branches` | `repos` | yes | `pkg/github/repositories.go` · `ListBranches` | List branches in a GitHub repository |
| `list_commits` | `repos` | yes | `pkg/github/repositories.go` · `ListCommits` | Get list of commits of a branch in a GitHub repository. Returns at least 30 results per page by default, but can return… |
| `list_releases` | `repos` | yes | `pkg/github/repositories.go` · `ListReleases` | List releases in a GitHub repository |
| `list_repository_collaborators` | `repos` | yes | `pkg/github/repositories.go` · `ListRepositoryCollaborators` | List collaborators of a GitHub repository. Results are paginated; the response includes `nextPage`, `prevPage`, `firstP… |
| `list_tags` | `repos` | yes | `pkg/github/repositories.go` · `ListTags` | List git tags in a GitHub repository |
| `push_files` | `repos` | — | `pkg/github/repositories.go` · `PushFiles` | Push multiple files to a GitHub repository in a single commit |
| `search_code` | `repos` | yes | `pkg/github/search.go` · `SearchCode` | Fast and precise code search across ALL GitHub repositories using GitHub's native search engine. Best for finding exact… |
| `search_commits` | `repos` | yes | `pkg/github/search.go` · `SearchCommits` | Search for commits across GitHub repositories using GitHub's commit search syntax. Useful for finding specific changes,… |
| `search_repositories` | `repos` | yes | `pkg/github/search.go` · `SearchRepositories` | Find GitHub repositories by name, description, readme, topics, or other metadata. Perfect for discovering projects, fin… |
| `get_secret_scanning_alert` | `secret_protection` | yes | `pkg/github/secret_scanning.go` · `GetSecretScanningAlert` | Get details of a specific secret scanning alert in a GitHub repository. |
| `list_secret_scanning_alerts` | `secret_protection` | yes | `pkg/github/secret_scanning.go` · `ListSecretScanningAlerts` | List secret scanning alerts in a GitHub repository. |
| `get_global_security_advisory` | `security_advisories` | yes | `pkg/github/security_advisories.go` · `GetGlobalSecurityAdvisory` | Get a global security advisory |
| `list_global_security_advisories` | `security_advisories` | yes | `pkg/github/security_advisories.go` · `ListGlobalSecurityAdvisories` | List global security advisories from GitHub. |
| `list_org_repository_security_advisories` | `security_advisories` | yes | `pkg/github/security_advisories.go` · `ListOrgRepositorySecurityAdvisories` | List repository security advisories for a GitHub organization. |
| `list_repository_security_advisories` | `security_advisories` | yes | `pkg/github/security_advisories.go` · `ListRepositorySecurityAdvisories` | List repository security advisories for a GitHub repository. |
| `list_starred_repositories` | `stargazers` | yes | `pkg/github/repositories.go` · `ListStarredRepositories` | List starred repositories |
| `star_repository` | `stargazers` | — | `pkg/github/repositories.go` · `StarRepository` | Star a GitHub repository |
| `unstar_repository` | `stargazers` | — | `pkg/github/repositories.go` · `UnstarRepository` | Unstar a GitHub repository |
| `search_users` | `users` | yes | `pkg/github/search.go` · `SearchUsers` | Find GitHub users by username, real name, or other profile information. Useful for locating developers, contributors, o… |

## Toolsets

| toolset | default | tools | description |
| --- | :---: | ---: | --- |
| `all` | — | 0 | Special toolset that enables all available toolsets |
| `default` | — | 0 | Special toolset that enables the default toolset configuration. When no toolsets are specified, this is the set that is enabled |
| `context` | yes | 4 | Tools that provide context about the current user and GitHub context you are operating in |
| `repos` | yes | 21 | GitHub Repository related tools |
| `git` | — | 1 | GitHub Git API related tools for low-level Git operations |
| `issues` | yes | 31 | GitHub Issues related tools |
| `pull_requests` | yes | 27 | GitHub Pull Request related tools |
| `users` | yes | 1 | GitHub User related tools |
| `orgs` | — | 1 | GitHub Organization related tools |
| `governance` | — | 4 | Repository governance tools for managing rulesets and custom properties at the repository, organization, and enterprise levels |
| `actions` | — | 4 | GitHub Actions workflows and CI/CD operations |
| `code_quality` | — | 1 | GitHub Code Quality related tools |
| `code_security` | — | 2 | Code security related tools, such as GitHub Code Scanning |
| `secret_protection` | — | 2 | Secret protection related tools, such as GitHub Secret Scanning |
| `dependabot` | — | 2 | Dependabot tools |
| `notifications` | — | 6 | GitHub Notifications related tools |
| `discussions` | — | 5 | GitHub Discussions related tools |
| `gists` | — | 4 | GitHub Gist related tools |
| `security_advisories` | — | 4 | Security advisories related tools |
| `projects` | — | 3 | GitHub Projects related tools |
| `stargazers` | — | 3 | GitHub Stargazers related tools |
| `labels` | — | 2 | GitHub Labels related tools |
| `copilot` | yes | 2 | Copilot related tools |
| `copilot_issue_intents` | — | 1 | Opt-in Copilot issue assignment tools that carry intent metadata (rationale, confidence, suggestion) |
| `copilot_spaces` | — | 0 | Copilot Spaces tools |
| `github_support_docs_search` | — | 0 | Retrieve documentation to answer GitHub product and support questions. Topics include: GitHub Actions Workflows, Authentication, ... |
