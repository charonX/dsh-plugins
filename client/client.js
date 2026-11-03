window.__ModuleLoader__.load({
	id: "@charonx/dsh-skills-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/shared/api.ts
		/** Default HTTP prefix owned by this plugin. */
		const DEFAULT_ROUTE_PREFIX = "/dsh-skills-manager";
		/** Default locale namespace of the Web Client surface. */
		const LOCALE_NAMESPACE = "skills-manager";
		// src/client/api.ts
		/** Failure reported by the Host, carrying the machine-readable code. */
		var ApiFailure = class extends Error {
			/**
			* @param status - HTTP status.
			* @param code - machine-readable failure code.
			* @param message - human-readable message.
			*/
			constructor(status, code, message) {
				super(message);
				this.status = status;
				this.code = code;
				this.name = "ApiFailure";
			}
		};
		/**
		* Resolve a route against the page the UI is served from.
		* @param path - route without the plugin prefix.
		* @returns the document-relative pathname.
		*/
		function apiPath(path) {
			const relative = `${DEFAULT_ROUTE_PREFIX.replace(/^\/+/u, "")}${path}`;
			if (typeof document === "undefined") return `/${relative}`;
			return new URL(relative, document.baseURI).pathname;
		}
		async function request(path, init) {
			const response = await fetch(apiPath(path), {
				...init,
				credentials: "same-origin",
				cache: "no-store",
				headers: {
					"content-type": "application/json",
					...init?.headers
				}
			});
			const text = await response.text();
			const body = text === "" ? void 0 : safeJson(text);
			if (!response.ok) {
				const failure = body;
				throw new ApiFailure(response.status, failure?.error?.code ?? "REQUEST_FAILED", failure?.error?.message ?? `Request failed with status ${String(response.status)}`);
			}
			return body;
		}
		function safeJson(text) {
			try {
				return JSON.parse(text);
			} catch {
				return;
			}
		}
		/**
		* Read the library snapshot.
		* @returns the current sources, skills, and manager state.
		*/
		async function loadLibrary() {
			return await request("/api/library");
		}
		/**
		* Start an install job.
		* @param body - source type, identifier, and optional overwrite flag.
		* @returns the job id to poll.
		*/
		async function installSource(body) {
			return (await request("/api/sources/install", {
				method: "POST",
				body: JSON.stringify(body)
			})).jobId;
		}
		/**
		* Start an update job.
		* @param slug - source slug.
		* @returns the job id to poll.
		*/
		async function updateSource(slug) {
			return (await request(`/api/sources/${encodeURIComponent(slug)}/update`, { method: "POST" })).jobId;
		}
		/**
		* Remove one source.
		* @param slug - source slug.
		* @returns the refreshed snapshot.
		*/
		async function removeSource(slug) {
			return await request(`/api/sources/${encodeURIComponent(slug)}`, { method: "DELETE" });
		}
		/**
		* Patch source state.
		* @param slug - source slug.
		* @param patch - fields to set.
		* @returns the refreshed snapshot.
		*/
		async function patchSource(slug, patch) {
			return await request(`/api/sources/${encodeURIComponent(slug)}`, {
				method: "PUT",
				body: JSON.stringify(patch)
			});
		}
		/**
		* Patch one skill's state.
		* @param slug - source slug.
		* @param skillName - skill directory name.
		* @param patch - fields to set.
		*/
		async function patchSkill(slug, skillName, patch) {
			await request(`/api/sources/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillName)}`, {
				method: "PUT",
				body: JSON.stringify(patch)
			});
		}
		/**
		* Poll one job until it settles.
		* @param jobId - job id.
		* @param onLog - receives the accumulated command output on every poll.
		* @throws {ApiFailure} carrying the job error code when the job fails.
		*/
		async function waitForJob(jobId, onLog) {
			for (;;) {
				const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
				onLog?.(job.log);
				if (job.status === "success") return;
				if (job.status === "error") throw new ApiFailure(500, job.error?.code ?? "SKILL_JOB_FAILED", job.error?.message ?? "Skill job failed");
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		}
		/**
		* Read the pinned agent-directory registry.
		* @returns one row per agent convention.
		*/
		async function loadAgents() {
			return (await request("/api/agents")).agents;
		}
		/**
		* Read every recorded project with its refreshed link state.
		* @returns one view per project.
		*/
		async function loadLinks() {
			return (await request("/api/links")).projects;
		}
		/**
		* Link a source (or one of its skills) into a project.
		* @param body - project, source, optional skill, and agent targets.
		* @returns the refreshed project report.
		*/
		async function linkSource(body) {
			return await request("/api/links", {
				method: "POST",
				body: JSON.stringify(body)
			});
		}
		/**
		* Remove links of a source (or one of its skills) from a project.
		* @param body - project, source, optional skill, and agent targets.
		* @returns the refreshed project report.
		*/
		async function unlinkSource(body) {
			return await request("/api/links", {
				method: "DELETE",
				body: JSON.stringify(body)
			});
		}
		/**
		* Rebuild every recorded link of one project.
		* @param project - absolute project directory.
		* @returns the refreshed project report.
		*/
		async function resyncProject(project) {
			return await request("/api/links/resync", {
				method: "POST",
				body: JSON.stringify({ project })
			});
		}
		/**
		* Fetch and record an update check for one git source.
		* @param slug - source slug.
		* @returns the observation; a comparison failure is carried on `error`.
		*/
		async function checkSource(slug) {
			return (await request(`/api/sources/${encodeURIComponent(slug)}/check`, { method: "POST" })).check;
		}
		/**
		* Read the DSH workspaces offered as link targets.
		* @returns workspace paths with their titles.
		*/
		async function loadWorkspaces() {
			return (await request("/api/projects")).projects;
		}
		/**
		* Turn this project's distribution of one skill (or a whole source) on or off.
		* @param body - project, source, optional skill, and the desired switch.
		* @returns the refreshed project report.
		*/
		async function setLinkEnabled(body) {
			return await request("/api/links", {
				method: "PUT",
				body: JSON.stringify(body)
			});
		}
		/**
		* Scan global skill roots offered for import.
		* @returns roots plus one row per discovered skill, with its import status.
		*/
		async function loadScan() {
			return await request("/api/scan");
		}
		/**
		* Copy the selected global skills into the library.
		* @param paths - absolute SKILL.md paths from the scan response.
		* @param overwrite - replace a conflicting copy previously imported here.
		* @returns one outcome per requested path.
		*/
		async function importSkills(paths, overwrite) {
			return await request("/api/import", {
				method: "POST",
				body: JSON.stringify({
					paths,
					...overwrite ? { overwrite: true } : {}
				})
			});
		}
		// src/client/SkillsPage.tsx
		/**
		* The Skills main-panel page, reached from the left sidebar.
		*
		* @module dsh-skills-manager/client/SkillsPage
		*/
		const COLORS = {
			text: "var(--dsw-alias-label-primary)",
			secondary: "var(--dsw-alias-label-secondary)",
			tertiary: "var(--dsw-alias-label-tertiary)",
			border: "var(--dsw-alias-border-l2)",
			borderStrong: "var(--dsw-alias-border-l4)",
			surface: "var(--dsw-alias-bg-layer-2)",
			surfaceAlt: "var(--dsw-alias-bg-layer-1)",
			error: "var(--dsw-alias-state-error-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			brand: "var(--dsw-alias-brand-primary)",
			onBrand: "var(--dsw-alias-label-primary-foreground)"
		};
		const cardStyle = {
			border: `1px solid ${COLORS.border}`,
			borderRadius: "var(--dsw-radius-md)",
			background: COLORS.surface,
			overflow: "hidden"
		};
		const buttonStyle = {
			border: `1px solid ${COLORS.borderStrong}`,
			borderRadius: "var(--dsw-radius-sm)",
			background: "transparent",
			color: COLORS.text,
			padding: "4px 10px",
			fontSize: 12,
			cursor: "pointer"
		};
		const primaryButtonStyle = {
			...buttonStyle,
			background: COLORS.brand,
			borderColor: COLORS.brand,
			color: COLORS.onBrand
		};
		const inputStyle = {
			width: "100%",
			boxSizing: "border-box",
			border: `1px solid ${COLORS.borderStrong}`,
			borderRadius: "var(--dsw-radius-sm)",
			background: "transparent",
			color: COLORS.text,
			padding: "6px 8px",
			fontSize: 13,
			fontFamily: "inherit"
		};
		const logStyle = {
			margin: 0,
			padding: "8px 12px",
			maxHeight: 220,
			overflow: "auto",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 11,
			color: COLORS.secondary
		};
		const STATE_COLORS = {
			linked: COLORS.success,
			missing: COLORS.tertiary,
			broken: COLORS.warn,
			conflict: COLORS.error,
			external: COLORS.tertiary
		};
		const STATE_KEYS = {
			linked: "linkStateLinked",
			missing: "linkStateMissing",
			broken: "linkStateBroken",
			conflict: "linkStateConflict",
			external: "linkStateExternal"
		};
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function codeOf(error) {
			return error instanceof ApiFailure ? error.code : "REQUEST_FAILED";
		}
		/** Skills management surface: sources, install flow, and project links. */
		function SkillsPage({ t }) {
			const [snapshot, setSnapshot] = (0, react.useState)(null);
			const [projects, setProjects] = (0, react.useState)([]);
			const [agents, setAgents] = (0, react.useState)([]);
			const [workspaces, setWorkspaces] = (0, react.useState)([]);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(null);
			const [log, setLog] = (0, react.useState)(null);
			const [expandedSources, setExpandedSources] = (0, react.useState)([]);
			const [expandedProjects, setExpandedProjects] = (0, react.useState)([]);
			const [installOpen, setInstallOpen] = (0, react.useState)(false);
			const [scanOpen, setScanOpen] = (0, react.useState)(false);
			const [linkTarget, setLinkTarget] = (0, react.useState)(null);
			const [pendingRemove, setPendingRemove] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				try {
					const [nextLibrary, nextLinks, nextAgents, nextWorkspaces] = await Promise.all([
						loadLibrary(),
						loadLinks(),
						loadAgents(),
						loadWorkspaces()
					]);
					setSnapshot(nextLibrary);
					setProjects(nextLinks);
					setAgents(nextAgents);
					setWorkspaces(nextWorkspaces);
					setError(null);
				} catch (failure) {
					setError({
						code: codeOf(failure),
						message: messageOf(failure)
					});
				} finally {
					setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const runAction = (0, react.useCallback)(async (key, action) => {
				setBusy(key);
				setNotice(null);
				try {
					await action();
				} catch (failure) {
					setError({
						code: codeOf(failure),
						message: messageOf(failure)
					});
				} finally {
					setBusy(null);
				}
			}, []);
			const mergeReport = (0, react.useCallback)((report) => {
				setProjects((current) => {
					return [...current.filter((project) => project.project !== report.project.project), report.project].sort((left, right) => left.project.localeCompare(right.project));
				});
			}, []);
			const onToggleSource = (0, react.useCallback)(async (source) => {
				await runAction(source.slug, async () => {
					setSnapshot(await patchSource(source.slug, { enabled: !source.enabled }));
					setProjects(await loadLinks());
				});
			}, [runAction]);
			const onToggleSkill = (0, react.useCallback)(async (source, skill) => {
				await runAction(`${source.slug}/${skill.skillName}`, async () => {
					await patchSkill(source.slug, skill.skillName, { enabled: !skill.enabled });
					await refresh();
				});
			}, [refresh, runAction]);
			const onUpdate = (0, react.useCallback)(async (source) => {
				await runAction(source.slug, async () => {
					const jobId = await updateSource(source.slug);
					setLog({
						slug: source.slug,
						text: ""
					});
					await waitForJob(jobId, (text) => {
						setLog({
							slug: source.slug,
							text: text ?? ""
						});
					});
					await refresh();
					setLog(null);
					setNotice(t("updateSucceeded", { slug: source.slug }));
				});
			}, [
				refresh,
				runAction,
				t
			]);
			const onRemove = (0, react.useCallback)(async (slug) => {
				setPendingRemove(null);
				await runAction(slug, async () => {
					setSnapshot(await removeSource(slug));
					setNotice(t("removedSucceeded", { slug }));
					const links = await loadLinks();
					setProjects(links);
				});
			}, [runAction, t]);
			const onCheck = (0, react.useCallback)(async (source) => {
				await runAction(`check:${source.slug}`, async () => {
					const check = await checkSource(source.slug);
					await refresh();
					if (check.error !== void 0) setError({
						code: check.error.code,
						message: check.error.message
					});
				});
			}, [refresh, runAction]);
			const onToggleEntry = (0, react.useCallback)(async (project, entry, enabled) => {
				await runAction(`link:${project}`, async () => {
					const report = await setLinkEnabled({
						project,
						source: entry.source,
						skillName: entry.skillName,
						enabled
					});
					mergeReport(report);
				});
			}, [mergeReport, runAction]);
			const onUnlinkEntry = (0, react.useCallback)(async (project, entry) => {
				await runAction(`link:${project}`, async () => {
					const report = await unlinkSource({
						project,
						source: entry.source,
						skillName: entry.skillName
					});
					mergeReport(report);
				});
			}, [mergeReport, runAction]);
			const onResyncProject = (0, react.useCallback)(async (project) => {
				await runAction(`link:${project}`, async () => {
					const report = await resyncProject(project);
					mergeReport(report);
					setNotice(t("linkResynced", { project }));
				});
			}, [
				mergeReport,
				runAction,
				t
			]);
			const onUnlinkProject = (0, react.useCallback)(async (project) => {
				await runAction(`link:${project}`, async () => {
					let latest = null;
					for (const entry of projects.find((candidate) => candidate.project === project)?.entries ?? []) latest = await unlinkSource({
						project,
						source: entry.source
					});
					if (latest !== null) mergeReport(latest);
					setNotice(t("linkUnlinked", { project }));
					setProjects(await loadLinks());
				});
			}, [
				mergeReport,
				projects,
				runAction,
				t
			]);
			const toggleSourceExpanded = (0, react.useCallback)((slug) => {
				setExpandedSources((current) => current.includes(slug) ? current.filter((entry) => entry !== slug) : [...current, slug]);
			}, []);
			const toggleProjectExpanded = (0, react.useCallback)((project) => {
				setExpandedProjects((current) => current.includes(project) ? current.filter((entry) => entry !== project) : [...current, project]);
			}, []);
			const filtered = useFiltered(snapshot, query);
			const counts = useCounts(snapshot);
			const existingSlugs = (0, react.useMemo)(() => (snapshot?.sources ?? []).map((source) => source.slug), [snapshot]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16,
					color: COLORS.text,
					height: "100%",
					overflowY: "auto",
					boxSizing: "border-box",
					padding: "24px 28px 48px"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						width: "100%",
						maxWidth: 1080,
						margin: "0 auto",
						display: "flex",
						flexDirection: "column",
						gap: 16
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "baseline",
										gap: 12,
										flexWrap: "wrap"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										style: {
											margin: 0,
											fontSize: 20,
											fontWeight: 600
										},
										children: t("title")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											color: COLORS.tertiary,
											fontSize: 12
										},
										children: [
											t("countSources", { count: counts.sources }),
											" · ",
											t("countSkills", { count: counts.skills })
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										margin: 0,
										color: COLORS.secondary,
										fontSize: 13
									},
									children: t("subtitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 8,
										alignItems: "center",
										flexWrap: "wrap"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											style: {
												...inputStyle,
												width: 240
											},
											value: query,
											placeholder: t("search"),
											"aria-label": t("search"),
											onChange: (event) => {
												setQuery(event.target.value);
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											disabled: busy !== null,
											onClick: () => {
												refresh();
											},
											children: t("refresh")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											disabled: busy !== null || (snapshot?.sources.length ?? 0) === 0,
											onClick: () => {
												setExpandedSources((snapshot?.sources ?? []).map((source) => source.slug));
											},
											children: t("expandAll")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											disabled: busy !== null || expandedSources.length === 0,
											onClick: () => {
												setExpandedSources([]);
											},
											children: t("collapseAll")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: buttonStyle,
											disabled: busy !== null,
											onClick: () => {
												setScanOpen(true);
											},
											children: t("scan")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											style: primaryButtonStyle,
											disabled: busy !== null,
											onClick: () => {
												setInstallOpen(true);
											},
											children: ["+ ", t("install")]
										})
									]
								})
							]
						}),
						notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...cardStyle,
								padding: "8px 12px",
								color: COLORS.success,
								fontSize: 13
							},
							role: "status",
							children: notice
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								...cardStyle,
								padding: "8px 12px",
								color: COLORS.error,
								fontSize: 13
							},
							role: "alert",
							children: t("failed", { message: `${error.message} (${error.code})` })
						}),
						log !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: cardStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									padding: "8px 12px",
									fontSize: 12,
									color: COLORS.secondary,
									borderBottom: `1px solid ${COLORS.border}`
								},
								children: t("installLog")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
								style: logStyle,
								children: log.text === "" ? "…" : log.text
							})]
						}),
						loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								color: COLORS.secondary,
								fontSize: 13
							},
							children: t("loading")
						}),
						!loading && snapshot !== null && snapshot.sources.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...cardStyle,
								padding: 24,
								textAlign: "center"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									margin: "0 0 6px",
									fontSize: 15,
									fontWeight: 600
								},
								children: t("emptyTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: {
									margin: 0,
									color: COLORS.secondary,
									fontSize: 13
								},
								children: t("emptyHint")
							})]
						}),
						!loading && snapshot !== null && snapshot.sources.length > 0 && filtered.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								color: COLORS.secondary,
								fontSize: 13
							},
							children: t("emptyFiltered")
						}),
						filtered.map(({ source, skills }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SourceCard, {
							t,
							source,
							skills,
							busy,
							expanded: query.trim() !== "" || expandedSources.includes(source.slug),
							onToggle: () => {
								toggleSourceExpanded(source.slug);
							},
							onUpdate,
							onRemove: (slug) => {
								setPendingRemove(slug);
							},
							onToggleSource,
							onToggleSkill,
							onLink: (value) => {
								setLinkTarget({ source: value });
							},
							onLinkSkill: (value, skill) => {
								setLinkTarget({
									source: value,
									skillName: skill.skillName
								});
							},
							onCheck
						}, source.slug)),
						projects.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProjectsSection, {
							t,
							projects,
							agents,
							busy,
							expanded: expandedProjects,
							onToggleProject: toggleProjectExpanded,
							onExpandAll: () => {
								setExpandedProjects(projects.map((project) => project.project));
							},
							onCollapseAll: () => {
								setExpandedProjects([]);
							},
							onResync: onResyncProject,
							onUnlink: onUnlinkProject,
							onToggleEntry,
							onUnlinkEntry
						}),
						scanOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScanDialog, {
							t,
							onClose: () => {
								setScanOpen(false);
							},
							onImported: () => {
								refresh();
							}
						}),
						installOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InstallDialog, {
							t,
							existingSlugs,
							onClose: () => {
								setInstallOpen(false);
							},
							onInstalled: (slug) => {
								setInstallOpen(false);
								setNotice(t("installedSucceeded", { slug }));
								refresh();
							}
						}),
						linkTarget !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LinkDialog, {
							t,
							source: linkTarget.source,
							agents,
							workspaces,
							...linkTarget.skillName === void 0 ? {} : { skillName: linkTarget.skillName },
							onClose: () => {
								setLinkTarget(null);
								refresh();
							},
							onLinked: (reports) => {
								const projects = reports.map((report) => report.project.project);
								for (const report of reports) mergeReport(report);
								setExpandedProjects((current) => [.../* @__PURE__ */ new Set([...current, ...projects])]);
								const linked = reports.reduce((total, report) => total + report.counts.linked, 0);
								setNotice(linkTarget.skillName === void 0 ? t("linkSucceededProjects", {
									count: linked,
									projects: projects.join(", ")
								}) : t("linkOneSucceeded", {
									skill: linkTarget.skillName,
									project: projects.join(", ")
								}));
								setTimeout(() => {
									document.getElementById("skills-manager-projects")?.scrollIntoView({
										behavior: "smooth",
										block: "start"
									});
								}, 50);
							}
						}),
						pendingRemove !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfirmRemove, {
							t,
							slug: pendingRemove,
							onCancel: () => {
								setPendingRemove(null);
							},
							onConfirm: (slug) => {
								onRemove(slug);
							}
						})
					]
				})
			});
		}
		function useFiltered(snapshot, query) {
			return (0, react.useMemo)(() => {
				const sources = snapshot?.sources ?? [];
				const needle = query.trim().toLowerCase();
				if (needle === "") return sources.map((source) => ({
					source,
					skills: [...source.skills]
				}));
				const result = [];
				for (const source of sources) {
					const skills = source.skills.filter((skill) => [
						skill.name,
						skill.skillName,
						skill.description
					].some((value) => value !== void 0 && value.toLowerCase().includes(needle)));
					const sourceMatches = source.slug.toLowerCase().includes(needle);
					if (skills.length > 0 || sourceMatches) result.push({
						source,
						skills: sourceMatches ? [...source.skills] : skills
					});
				}
				return result;
			}, [snapshot, query]);
		}
		function useCounts(snapshot) {
			return (0, react.useMemo)(() => {
				const sources = snapshot?.sources ?? [];
				return {
					sources: sources.length,
					skills: sources.reduce((total, source) => total + source.skills.length, 0)
				};
			}, [snapshot]);
		}
		function SourceCard({ t, source, skills, busy, expanded, onToggle, onUpdate, onRemove, onToggleSource, onToggleSkill, onLink, onLinkSkill, onCheck }) {
			const working = busy === source.slug;
			const checking = busy === `check:${source.slug}`;
			const update = source.update;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: cardStyle,
				"aria-label": source.slug,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						onClick: onToggle,
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10,
							flexWrap: "wrap",
							padding: "10px 12px",
							cursor: "pointer",
							borderBottom: skills.length === 0 || !expanded ? void 0 : `1px solid ${COLORS.border}`
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-expanded": expanded,
								"aria-label": expanded ? t("collapseSource") : t("expandSource"),
								title: expanded ? t("collapseSource") : t("expandSource"),
								onClick: (event) => {
									event.stopPropagation();
									onToggle();
								},
								style: {
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									width: 20,
									height: 20,
									padding: 0,
									border: "none",
									borderRadius: "var(--dsw-radius-xs)",
									background: "transparent",
									color: COLORS.tertiary,
									cursor: "pointer",
									transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
									transition: "transform 120ms ease"
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									width: "12",
									height: "12",
									viewBox: "0 0 12 12",
									fill: "none",
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										d: "M4.5 2.5L8 6l-3.5 3.5",
										stroke: "currentColor",
										strokeWidth: "1.4",
										strokeLinecap: "round",
										strokeLinejoin: "round"
									})
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
								style: { fontSize: 14 },
								children: source.slug
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: source.sourceType === "git" ? "git" : "local" }),
							source.version !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: COLORS.tertiary
								},
								children: t("version", { version: source.version })
							}),
							!source.enabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								text: t("disabled"),
								tone: "warn"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(UpdateBadge, {
								t,
								update
							}),
							!expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: COLORS.tertiary
								},
								children: t("countSkills", { count: skills.length })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								onClick: (event) => {
									event.stopPropagation();
								},
								style: {
									display: "inline-flex",
									alignItems: "center",
									gap: 10,
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
										checked: source.enabled,
										label: source.enabled ? t("disableSource") : t("enableSource"),
										disabled: busy !== null,
										onChange: () => {
											onToggleSource(source);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null,
										onClick: () => {
											onLink(source);
										},
										children: t("link")
									}),
									source.sourceType === "git" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null,
										onClick: () => {
											onCheck(source);
										},
										children: checking ? t("checking") : t("checkUpdates")
									}),
									source.sourceType === "git" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null,
										onClick: () => {
											onUpdate(source);
										},
										children: working ? t("updating") : t("update")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null,
										onClick: () => {
											onRemove(source.slug);
										},
										children: t("remove")
									})
								]
							})
						]
					}),
					expanded && source.sourceUrl !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "6px 12px",
							fontSize: 11,
							color: COLORS.tertiary,
							wordBreak: "break-all"
						},
						children: source.sourceUrl
					}),
					source.problem !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "6px 12px",
							fontSize: 12,
							color: COLORS.warn
						},
						children: source.problem
					}),
					expanded && source.note !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							padding: "0 12px 6px",
							fontSize: 12,
							color: COLORS.secondary
						},
						children: [
							t("note"),
							": ",
							source.note
						]
					}),
					expanded && (skills.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "10px 12px",
							fontSize: 12,
							color: COLORS.tertiary
						},
						children: t("noSkills")
					}) : skills.map((skill) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillRow, {
						t,
						source,
						skill,
						busy: busy !== null,
						onToggle: () => {
							onToggleSkill(source, skill);
						},
						onLink: () => {
							onLinkSkill(source, skill);
						}
					}, skill.skillName)))
				]
			});
		}
		function SkillRow({ t, source, skill, busy, onToggle, onLink }) {
			const disabledBySource = !source.enabled;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "flex-start",
					gap: 10,
					padding: "10px 12px",
					borderTop: `1px solid ${COLORS.border}`,
					opacity: disabledBySource ? .55 : 1
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 3,
							flex: 1,
							minWidth: 0
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											fontWeight: 500
										},
										children: skill.name ?? skill.skillName
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										style: {
											fontSize: 11,
											color: COLORS.tertiary
										},
										children: skill.skillName
									}),
									!skill.valid && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
										text: t("invalid"),
										tone: "warn"
									}),
									skill.invocation.modelInvocable && !skill.invocation.userInvocable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: t("modelOnly") }),
									!skill.invocation.modelInvocable && skill.invocation.userInvocable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: t("userOnly") })
								]
							}),
							skill.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: COLORS.secondary
								},
								children: skill.description
							}),
							skill.problem !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: COLORS.warn
								},
								children: skill.problem
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								title: skill.relativePath,
								style: {
									fontSize: 11,
									color: COLORS.tertiary
								},
								children: [
									t("skillPath"),
									": ",
									skill.relativePath
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle,
						disabled: busy || disabledBySource,
						onClick: onLink,
						children: t("linkSkill")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
						checked: skill.enabled,
						label: skill.enabled ? t("disabled") : t("enabled"),
						disabled: busy || disabledBySource,
						onChange: onToggle
					})
				]
			});
		}
		/** Entries of a project, each row collapsing to one line with its agent names. */
		function ProjectsSection({ t, projects, agents, busy, expanded, onToggleProject, onExpandAll, onCollapseAll, onResync, onUnlink, onToggleEntry, onUnlinkEntry }) {
			const nameOf = (key) => agents.find((agent) => agent.name === key)?.displayName ?? key;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				id: "skills-manager-projects",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 8
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: {
								margin: 0,
								fontSize: 14,
								fontWeight: 600
							},
							children: t("linkedProjects")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							onClick: onExpandAll,
							children: t("expandAll")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							disabled: expanded.length === 0,
							onClick: onCollapseAll,
							children: t("collapseAll")
						})
					]
				}), projects.map((project) => {
					const open = expanded.includes(project.project);
					const working = busy === `link:${project.project}`;
					const counts = project.targets.reduce((total, target) => {
						total[target.state] = (total[target.state] ?? 0) + 1;
						return total;
					}, {});
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: cardStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							onClick: () => {
								onToggleProject(project.project);
							},
							style: {
								display: "flex",
								alignItems: "center",
								gap: 10,
								flexWrap: "wrap",
								padding: "10px 12px",
								cursor: "pointer",
								borderBottom: open && project.exists ? `1px solid ${COLORS.border}` : void 0
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"aria-expanded": open,
									"aria-label": open ? t("collapseProject") : t("expandProject"),
									onClick: (event) => {
										event.stopPropagation();
										onToggleProject(project.project);
									},
									style: {
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center",
										width: 20,
										height: 20,
										padding: 0,
										border: "none",
										borderRadius: "var(--dsw-radius-xs)",
										background: "transparent",
										color: COLORS.tertiary,
										cursor: "pointer",
										transform: open ? "rotate(90deg)" : "rotate(0deg)",
										transition: "transform 120ms ease"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
										width: "12",
										height: "12",
										viewBox: "0 0 12 12",
										fill: "none",
										"aria-hidden": "true",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
											d: "M4.5 2.5L8 6l-3.5 3.5",
											stroke: "currentColor",
											strokeWidth: "1.4",
											strokeLinecap: "round",
											strokeLinejoin: "round"
										})
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									title: project.project,
									style: {
										fontSize: 12,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										maxWidth: "42%"
									},
									children: project.project
								}),
								!project.exists && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
									text: t("projectMissing"),
									tone: "warn"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: COLORS.tertiary
									},
									children: project.agents.map(nameOf).join(" · ")
								}),
								!open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: COLORS.tertiary
									},
									children: t("countSkills", { count: project.entries.length })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								Object.entries(counts).map(([state, count]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 11,
										color: STATE_COLORS[state] ?? COLORS.tertiary
									},
									children: [
										t(STATE_KEYS[state] ?? state),
										" ",
										count
									]
								}, state)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									onClick: (event) => {
										event.stopPropagation();
									},
									style: {
										display: "inline-flex",
										gap: 8
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null || !project.exists,
										onClick: () => {
											onResync(project.project);
										},
										children: working ? t("loading") : t("resync")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle,
										disabled: busy !== null || !project.exists,
										onClick: () => {
											onUnlink(project.project);
										},
										children: t("unlinkAll")
									})]
								})
							]
						}), open && project.exists && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { padding: "6px 12px 10px" },
							children: project.entries.map((entry) => {
								const stale = project.stale.some((candidate) => candidate.source === entry.source && candidate.skillName === entry.skillName);
								const states = entryStates(project, entry);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 8,
										alignItems: "center",
										fontSize: 12,
										padding: "3px 0"
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
											checked: entry.enabled,
											label: entry.enabled ? t("disabled") : t("enabled"),
											disabled: busy !== null,
											onChange: () => {
												onToggleEntry(project.project, entry, !entry.enabled);
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
											style: { color: COLORS.secondary },
											children: [
												entry.source,
												"/",
												entry.skillName
											]
										}),
										stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: COLORS.warn },
											children: t("staleEntry")
										}) : entry.enabled === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											text: t("disabled"),
											tone: "warn"
										}) : states.map(({ state, agents: agentKeys }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: { color: STATE_COLORS[state] ?? COLORS.tertiary },
											children: [
												t(STATE_KEYS[state] ?? state),
												" ",
												agentKeys.map(nameOf).join(" · ")
											]
										}, state)),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: {
												...buttonStyle,
												padding: "0 6px",
												fontSize: 10
											},
											disabled: busy !== null,
											onClick: () => {
												onUnlinkEntry(project.project, entry);
											},
											children: t("unlinkOne")
										})
									]
								}, `${entry.source}/${entry.skillName}`);
							})
						})]
					}, project.project);
				})]
			});
		}
		/** Aggregate one entry's link positions into state → agent names. */
		function entryStates(project, entry) {
			const byState = /* @__PURE__ */ new Map();
			for (const target of project.targets) {
				if (target.skillName !== entry.skillName) continue;
				if (target.source !== void 0 && target.source !== entry.source) continue;
				const set = byState.get(target.state) ?? /* @__PURE__ */ new Set();
				for (const agent of target.agents) set.add(agent);
				byState.set(target.state, set);
			}
			return [...byState.entries()].map(([state, agents]) => ({
				state,
				agents: [...agents]
			}));
		}
		/** Scan well-known global skill roots and copy selected skills into the library. */
		function ScanDialog({ t, onClose, onImported }) {
			const [scan, setScan] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(true);
			const [error, setError] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [selected, setSelected] = (0, react.useState)([]);
			const [overwrite, setOverwrite] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async () => {
				setLoading(true);
				try {
					setScan(await loadScan());
					setError(null);
				} catch (failure) {
					setError(`${messageOf(failure)} (${codeOf(failure)})`);
				} finally {
					setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			const groups = (0, react.useMemo)(() => {
				const needle = query.trim().toLowerCase();
				const matches = (skill) => needle === "" || [
					skill.name,
					skill.description,
					skill.originLabel
				].some((value) => value !== void 0 && value.toLowerCase().includes(needle));
				const byOrigin = /* @__PURE__ */ new Map();
				for (const skill of scan?.skills ?? []) {
					if (!matches(skill)) continue;
					const list = byOrigin.get(skill.originKey) ?? [];
					list.push(skill);
					byOrigin.set(skill.originKey, list);
				}
				return (scan?.roots ?? []).map((root) => ({
					root,
					skills: byOrigin.get(root.key) ?? []
				})).filter((group) => needle === "" || group.skills.length > 0 || group.root.label.toLowerCase().includes(needle));
			}, [query, scan]);
			const selectable = (skill) => skill.status === "importable" || skill.status === "conflict" && overwrite;
			const toggle = (path) => {
				setSelected((current) => current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]);
			};
			const submit = (0, react.useCallback)(async () => {
				if (selected.length === 0 || busy) return;
				setBusy(true);
				setError(null);
				setResult(null);
				try {
					const response = await importSkills(selected, overwrite);
					setResult(response);
					setSelected([]);
					onImported();
					setScan(await loadScan());
				} catch (failure) {
					setError(`${messageOf(failure)} (${codeOf(failure)})`);
				} finally {
					setBusy(false);
				}
			}, [
				busy,
				onImported,
				overwrite,
				selected
			]);
			const counts = result === null ? null : {
				imported: result.outcomes.filter((outcome) => outcome.status === "imported" || outcome.status === "overwritten").length,
				skipped: result.outcomes.filter((outcome) => outcome.status === "skipped").length,
				conflict: result.outcomes.filter((outcome) => outcome.status === "conflict").length,
				failed: result.outcomes.filter((outcome) => outcome.status === "failed").length
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Overlay, {
				onClose: busy ? void 0 : onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...cardStyle,
						width: "min(720px, 94vw)",
						maxHeight: "86vh",
						display: "flex",
						flexDirection: "column",
						background: COLORS.surfaceAlt
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: "12px 14px",
								borderBottom: `1px solid ${COLORS.border}`
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { fontWeight: 600 },
								children: t("scanTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 4,
									fontSize: 12,
									color: COLORS.secondary
								},
								children: t("scanSubtitle")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: "10px 14px",
								display: "flex",
								gap: 8,
								alignItems: "center",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: {
										...inputStyle,
										width: 220
									},
									value: query,
									placeholder: t("scanSearch"),
									"aria-label": t("scanSearch"),
									onChange: (event) => {
										setQuery(event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: COLORS.tertiary
									},
									children: t("scanSelected", { count: selected.length })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 6,
										fontSize: 12,
										color: COLORS.secondary
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: overwrite,
										disabled: busy,
										onChange: (event) => {
											setOverwrite(event.target.checked);
											if (!event.target.checked) setSelected((current) => current.filter((path) => {
												const skill = scan?.skills.find((entry) => entry.path === path);
												return skill === void 0 || skill.status !== "conflict";
											}));
										}
									}), t("scanOverwrite")]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: "0 14px 6px",
								fontSize: 11,
								color: COLORS.tertiary,
								display: "flex",
								gap: 8,
								alignItems: "center",
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("scanOverwriteHint") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("scanRootsSummary", {
									exists: (scan?.roots ?? []).filter((root) => root.exists).length,
									total: (scan?.roots ?? []).length
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "·" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("scanRootsHint") })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								overflow: "auto",
								padding: "0 14px 10px",
								display: "flex",
								flexDirection: "column",
								gap: 2
							},
							children: [
								loading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										color: COLORS.secondary,
										fontSize: 13
									},
									children: t("scanLoading")
								}),
								error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										color: COLORS.error,
										fontSize: 12
									},
									role: "alert",
									children: error
								}),
								!loading && groups.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: {
										color: COLORS.secondary,
										fontSize: 13
									},
									children: t("scanEmpty")
								}),
								groups.map(({ root, skills: groupSkills }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { marginTop: 6 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "baseline",
											gap: 8,
											padding: "4px 2px",
											borderBottom: `1px solid ${COLORS.border}`
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
												style: { fontSize: 12 },
												children: root.label
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												title: root.path,
												style: {
													fontSize: 10,
													color: COLORS.tertiary,
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
													maxWidth: "50%"
												},
												children: root.path
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 11,
													color: COLORS.tertiary
												},
												children: t("countSkills", { count: groupSkills.length })
											}),
											!root.exists && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
												text: t("scanMissingRoot"),
												tone: "warn"
											}),
											root.exists && groupSkills.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 11,
													color: COLORS.tertiary
												},
												children: t("scanGroupEmpty")
											})
										]
									}), groupSkills.map((skill) => {
										const checkboxId = `scan-${skill.path}`;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											htmlFor: checkboxId,
											title: skill.path,
											style: {
												display: "flex",
												gap: 8,
												alignItems: "flex-start",
												padding: "6px 4px 6px 12px",
												borderBottom: `1px solid ${COLORS.border}`,
												opacity: selectable(skill) ? 1 : .6,
												cursor: selectable(skill) ? "pointer" : "default"
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												id: checkboxId,
												type: "checkbox",
												checked: selected.includes(skill.path),
												disabled: busy || !selectable(skill),
												onChange: () => {
													toggle(skill.path);
												},
												style: { marginTop: 3 }
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													display: "flex",
													flexDirection: "column",
													gap: 2,
													flex: 1,
													minWidth: 0
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														style: {
															display: "flex",
															gap: 8,
															alignItems: "center",
															flexWrap: "wrap"
														},
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
																style: { fontSize: 13 },
																children: skill.name
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
																style: {
																	fontSize: 11,
																	color: COLORS.tertiary
																},
																children: skill.dirName
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScanStatus, {
																t,
																skill
															})
														]
													}),
													skill.description !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															fontSize: 12,
															color: COLORS.secondary
														},
														children: skill.description
													}),
													skill.problem !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															fontSize: 11,
															color: COLORS.warn
														},
														children: skill.problem
													}),
													skill.existing !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															fontSize: 11,
															color: COLORS.tertiary
														},
														children: t("scanConflictDetail", { source: `${skill.existing.source}/${skill.existing.skillName}` })
													})
												]
											})]
										}, skill.path);
									})]
								}, root.key))
							]
						}),
						counts !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: "8px 14px",
								fontSize: 12,
								borderTop: `1px solid ${COLORS.border}`,
								display: "flex",
								gap: 12,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: COLORS.success },
									children: t("scanResultImported", { count: counts.imported })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: COLORS.tertiary },
									children: t("scanResultSkipped", { count: counts.skipped })
								}),
								counts.conflict > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: COLORS.warn },
									children: t("scanResultConflicts", { count: counts.conflict })
								}),
								counts.failed > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: COLORS.error },
									children: t("scanResultFailed", { count: counts.failed })
								}),
								result?.outcomes.filter((outcome) => outcome.status === "conflict" || outcome.status === "failed").map((outcome) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										color: COLORS.warn,
										width: "100%"
									},
									children: [
										outcome.name,
										": ",
										outcome.message ?? outcome.code
									]
								}, outcome.path))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "flex-end",
								gap: 8,
								padding: "10px 14px",
								borderTop: `1px solid ${COLORS.border}`
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: onClose,
								children: counts === null ? t("cancel") : t("scanDone")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								disabled: busy || selected.length === 0,
								onClick: () => {
									submit();
								},
								children: busy ? t("scanImporting") : t("scanImport")
							})]
						})
					]
				})
			});
		}
		function ScanStatus({ t, skill }) {
			switch (skill.status) {
				case "importable": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: t("scanImportable") });
				case "imported": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: t("scanImported") });
				case "conflict": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
					text: t("scanConflict"),
					tone: "warn"
				});
				case "invalid": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
					text: t("scanInvalid"),
					tone: "warn"
				});
			}
		}
		function LinkDialog({ t, source, skillName, agents, workspaces, onClose, onLinked }) {
			const [projects, setProjects] = (0, react.useState)([]);
			const [customPath, setCustomPath] = (0, react.useState)("");
			const [pickerOpen, setPickerOpen] = (0, react.useState)(false);
			const [selected, setSelected] = (0, react.useState)(["dsh"]);
			const [agentQuery, setAgentQuery] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const visibleAgents = (0, react.useMemo)(() => {
				const needle = agentQuery.trim().toLowerCase();
				if (needle === "") return agents;
				return agents.filter((agent) => agent.name.toLowerCase().includes(needle) || agent.displayName.toLowerCase().includes(needle));
			}, [agentQuery, agents]);
			const projectLabel = (path) => workspaces.find((workspace) => workspace.path === path)?.title ?? path.split("/").filter(Boolean).pop() ?? path;
			const toggleAgent = (key) => {
				setSelected((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);
			};
			const toggleProject = (path) => {
				setProjects((current) => current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]);
			};
			const addCustomProject = () => {
				const path = customPath.trim();
				if (path === "") return;
				if (!projects.includes(path)) setProjects((current) => [...current, path]);
				setCustomPath("");
			};
			const submit = (0, react.useCallback)(async () => {
				if (busy) return;
				if (projects.length === 0) {
					setError(t("projectRequired"));
					return;
				}
				if (selected.length === 0) {
					setError(t("agentsRequired"));
					return;
				}
				setBusy(true);
				setError(null);
				const reports = [];
				const failures = [];
				for (const project of projects) try {
					reports.push(await linkSource({
						project,
						source: source.slug,
						agents: selected,
						...skillName === void 0 ? {} : { skillName }
					}));
				} catch (failure) {
					console.warn("[skills-manager] link failed:", project, codeOf(failure), messageOf(failure));
					failures.push(`${project}: ${messageOf(failure)} (${codeOf(failure)})`);
				}
				if (reports.length > 0) onLinked(reports);
				if (failures.length > 0) {
					setError(failures.join("\n"));
					setBusy(false);
					return;
				}
				setBusy(false);
				onClose();
			}, [
				busy,
				onClose,
				onLinked,
				projects,
				selected,
				skillName,
				source.slug,
				t
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Overlay, {
				onClose: busy ? void 0 : onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...cardStyle,
						overflow: "visible",
						width: "min(620px, 94vw)",
						background: COLORS.surfaceAlt
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "12px 14px",
								borderBottom: `1px solid ${COLORS.border}`,
								fontWeight: 600
							},
							children: t("linkTitle", { slug: skillName === void 0 ? source.slug : `${source.slug}/${skillName}` })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: 14,
								display: "flex",
								flexDirection: "column",
								gap: 10
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 4,
										fontSize: 12,
										color: COLORS.secondary
									},
									children: [t("linkProject"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { position: "relative" },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											"aria-expanded": pickerOpen,
											"aria-label": t("selectProjects"),
											disabled: busy,
											onClick: () => {
												setPickerOpen((open) => !open);
											},
											style: {
												...inputStyle,
												display: "flex",
												alignItems: "center",
												gap: 6,
												flexWrap: "wrap",
												minHeight: 34,
												textAlign: "left",
												cursor: "pointer"
											},
											children: [
												projects.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: { color: COLORS.tertiary },
													children: t("selectProjects")
												}),
												projects.map((path) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: {
														display: "inline-flex",
														alignItems: "center",
														gap: 4,
														padding: "2px 6px",
														borderRadius: 999,
														border: `1px solid ${COLORS.border}`,
														fontSize: 12
													},
													children: [projectLabel(path), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														role: "button",
														tabIndex: 0,
														"aria-label": `${t("removeProject")}: ${path}`,
														onClick: (event) => {
															event.stopPropagation();
															toggleProject(path);
														},
														onKeyDown: (event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.stopPropagation();
																toggleProject(path);
															}
														},
														style: {
															cursor: "pointer",
															color: COLORS.tertiary
														},
														children: "×"
													})]
												}, path)),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: {
														marginLeft: "auto",
														color: COLORS.tertiary
													},
													children: pickerOpen ? "▴" : "▾"
												})
											]
										}), pickerOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												position: "absolute",
												top: "calc(100% + 4px)",
												left: 0,
												right: 0,
												zIndex: 5,
												border: `1px solid ${COLORS.borderStrong}`,
												borderRadius: "var(--dsw-radius-sm)",
												background: "var(--dsw-alias-bg-layer-1)",
												boxShadow: "0 8px 24px var(--dsw-alias-bg-mask-2)",
												maxHeight: 260,
												overflow: "auto",
												padding: 6
											},
											children: [
												workspaces.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														padding: "4px 6px",
														fontSize: 12,
														color: COLORS.tertiary
													},
													children: t("customProjectPath")
												}),
												workspaces.map((workspace) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													title: workspace.path,
													style: {
														display: "flex",
														alignItems: "center",
														gap: 8,
														padding: "4px 6px",
														fontSize: 12,
														cursor: "pointer"
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: projects.includes(workspace.path),
															disabled: busy,
															onChange: () => {
																toggleProject(workspace.path);
															}
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: workspace.title }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
															style: {
																fontSize: 10,
																color: COLORS.tertiary,
																marginLeft: "auto"
															},
															children: workspace.path
														})
													]
												}, workspace.path)),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: {
														display: "flex",
														gap: 6,
														padding: 6,
														marginTop: 4,
														borderTop: `1px solid ${COLORS.border}`
													},
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														style: {
															...inputStyle,
															padding: "2px 6px"
														},
														value: customPath,
														placeholder: t("customProjectPath"),
														"aria-label": t("customProjectPath"),
														disabled: busy,
														onChange: (event) => {
															setCustomPath(event.target.value);
														},
														onKeyDown: (event) => {
															if (event.key === "Enter") {
																event.preventDefault();
																addCustomProject();
															}
														}
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														style: buttonStyle,
														disabled: busy || customPath.trim() === "",
														onClick: addCustomProject,
														children: t("addProject")
													})]
												})
											]
										}) })]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 4,
										fontSize: 12,
										color: COLORS.secondary
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												display: "flex",
												alignItems: "baseline",
												gap: 8
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("linkAgents") }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: { color: COLORS.tertiary },
													children: t("agentCount", { count: selected.length })
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													style: {
														...inputStyle,
														width: 160,
														padding: "2px 6px"
													},
													value: agentQuery,
													placeholder: t("agentsSearch"),
													"aria-label": t("agentsSearch"),
													onChange: (event) => {
														setAgentQuery(event.target.value);
													}
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												maxHeight: 200,
												overflow: "auto",
												border: `1px solid ${COLORS.border}`,
												borderRadius: "var(--dsw-radius-sm)",
												padding: "4px 8px"
											},
											children: visibleAgents.map((agent) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												style: {
													display: "flex",
													alignItems: "center",
													gap: 8,
													padding: "3px 0",
													fontSize: 12,
													color: COLORS.text,
													cursor: "pointer"
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "checkbox",
														checked: selected.includes(agent.name),
														disabled: busy,
														onChange: () => {
															toggleAgent(agent.name);
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: agent.displayName }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
														style: {
															fontSize: 10,
															color: COLORS.tertiary
														},
														children: agent.skillsDir
													}),
													agent.universal && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, { text: "universal" })
												]
											}, agent.name))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: COLORS.tertiary },
											children: t("linkAgentsHint")
										})
									]
								}),
								error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										color: COLORS.error,
										whiteSpace: "pre-wrap"
									},
									role: "alert",
									children: error
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "flex-end",
								gap: 8,
								padding: "10px 14px",
								borderTop: `1px solid ${COLORS.border}`
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: onClose,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								disabled: busy,
								onClick: () => {
									submit();
								},
								children: busy ? t("linking") : t("linkStart")
							})]
						})
					]
				})
			});
		}
		function UpdateBadge({ t, update }) {
			if (update === void 0) return null;
			const checkedAt = new Date(update.checkedAt);
			const time = Number.isNaN(checkedAt.getTime()) ? update.checkedAt : checkedAt.toLocaleString();
			if (update.error !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: 11,
					color: COLORS.warn
				},
				children: t("updateError", { message: update.error.message })
			});
			const behind = update.behind ?? 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					fontSize: 11
				},
				children: [
					behind > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
						text: t("updateAvailable", { count: behind }),
						tone: "warn"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: COLORS.tertiary },
						children: t("updateCurrent")
					}),
					update.dirty === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
						text: t("updateDirty"),
						tone: "warn"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { color: COLORS.tertiary },
						children: t("updateChecked", { time })
					})
				]
			});
		}
		function Switch({ checked, label, disabled = false, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				title: label,
				disabled,
				onClick: onChange,
				style: {
					position: "relative",
					width: 34,
					height: 20,
					flex: "0 0 auto",
					padding: 0,
					borderRadius: 999,
					border: "none",
					background: checked ? COLORS.brand : COLORS.borderStrong,
					cursor: disabled ? "default" : "pointer",
					opacity: disabled ? .5 : 1
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
					position: "absolute",
					top: 2,
					left: checked ? 16 : 2,
					width: 16,
					height: 16,
					borderRadius: "50%",
					background: COLORS.onBrand,
					transition: "left 120ms ease"
				} })
			});
		}
		function Badge({ text, tone = "neutral" }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: 10,
					lineHeight: "16px",
					padding: "0 6px",
					borderRadius: 999,
					border: `1px solid ${tone === "warn" ? COLORS.warn : COLORS.border}`,
					color: tone === "warn" ? COLORS.warn : COLORS.tertiary,
					letterSpacing: .4
				},
				children: text
			});
		}
		function InstallDialog({ t, existingSlugs, onClose, onInstalled }) {
			const [sourceType, setSourceType] = (0, react.useState)("git");
			const [identifier, setIdentifier] = (0, react.useState)("");
			const [force, setForce] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [log, setLog] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const submit = (0, react.useCallback)(async () => {
				if (identifier.trim() === "" || busy) return;
				setBusy(true);
				setError(null);
				setLog(null);
				try {
					await waitForJob(await installSource({
						sourceType,
						identifier: identifier.trim(),
						...sourceType === "local" && force ? { force: true } : {}
					}), (text) => {
						setLog(text);
					});
					onInstalled((await loadLibrary()).sources.find((source) => !existingSlugs.includes(source.slug))?.slug ?? identifier.trim());
				} catch (failure) {
					setError(`${messageOf(failure)} (${codeOf(failure)})`);
				} finally {
					setBusy(false);
				}
			}, [
				busy,
				existingSlugs,
				force,
				identifier,
				onInstalled,
				sourceType
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Overlay, {
				onClose: busy ? void 0 : onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...cardStyle,
						width: "min(560px, 92vw)",
						background: COLORS.surfaceAlt
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "12px 14px",
								borderBottom: `1px solid ${COLORS.border}`,
								fontWeight: 600
							},
							children: t("installTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								padding: 14,
								display: "flex",
								flexDirection: "column",
								gap: 10
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										display: "flex",
										gap: 14
									},
									children: ["git", "local"].map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 6,
											fontSize: 13,
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "skills-manager-source-type",
											checked: sourceType === value,
											disabled: busy,
											onChange: () => {
												setSourceType(value);
											}
										}), value === "git" ? t("sourceTypeGit") : t("sourceTypeLocal")]
									}, value))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 4,
										fontSize: 12,
										color: COLORS.secondary
									},
									children: [sourceType === "git" ? t("identifierGit") : t("identifierLocal"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: inputStyle,
										value: identifier,
										disabled: busy,
										autoFocus: true,
										placeholder: sourceType === "git" ? t("identifierGitHint") : t("identifierLocalHint"),
										onChange: (event) => {
											setIdentifier(event.target.value);
										},
										onKeyDown: (event) => {
											if (event.key === "Enter") submit();
										}
									})]
								}),
								sourceType === "local" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 6,
										fontSize: 12,
										color: COLORS.secondary
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: force,
										disabled: busy,
										onChange: (event) => {
											setForce(event.target.checked);
										}
									}), t("forceLocal")]
								}),
								error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										color: COLORS.error
									},
									role: "alert",
									children: error
								}),
								log !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										...cardStyle,
										maxHeight: 220,
										overflow: "auto"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
										style: logStyle,
										children: log === "" ? "…" : log
									})
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "flex-end",
								gap: 8,
								padding: "10px 14px",
								borderTop: `1px solid ${COLORS.border}`
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: onClose,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								disabled: busy || identifier.trim() === "",
								onClick: () => {
									submit();
								},
								children: busy ? t("installRunning") : t("installStart")
							})]
						})
					]
				})
			});
		}
		function ConfirmRemove({ t, slug, onCancel, onConfirm }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Overlay, {
				onClose: onCancel,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						...cardStyle,
						width: "min(440px, 92vw)",
						padding: 16,
						background: COLORS.surfaceAlt
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: {
								margin: "0 0 8px",
								fontSize: 16
							},
							children: t("removeTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: "0 0 14px",
								fontSize: 13,
								color: COLORS.secondary
							},
							children: t("removeMessage", { slug })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "flex-end",
								gap: 8
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								onClick: onCancel,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...primaryButtonStyle,
									background: COLORS.error,
									borderColor: COLORS.error
								},
								onClick: () => {
									onConfirm(slug);
								},
								children: t("removeConfirm")
							})]
						})
					]
				})
			});
		}
		function Overlay({ children, onClose }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "presentation",
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 60,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: "var(--dsw-alias-bg-mask-2)"
				},
				onClick: () => {
					onClose?.();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					role: "dialog",
					"aria-modal": "true",
					onClick: (event) => {
						event.stopPropagation();
					},
					children
				})
			});
		}
		// src/client/SkillsPanelIcon.tsx
		/**
		* Render the skills glyph at the size the sidebar asks for.
		* @param props - the sidebar's icon share: the requested edge and selection state.
		* @returns the icon element.
		*/
		function SkillsPanelIcon({ size }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true",
				focusable: "false",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "3.25",
						y: "3.25",
						width: "13.5",
						height: "13.5",
						rx: "2.5",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M6.75 7.5h6.5M6.75 10.25h6.5M6.75 13h4",
						stroke: "currentColor",
						strokeWidth: "1.3",
						strokeLinecap: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12.9 12.1l.55 1.4 1.4.55-1.4.55-.55 1.4-.55-1.4-1.4-.55 1.4-.55.55-1.4Z",
						fill: "currentColor"
					})
				]
			});
		}
		// src/client/locales.ts
		/**
		* Web Client copy for the skills manager.
		*
		* @module dsh-skills-manager/client/locales
		*/
		/** English dictionary; its keys define the namespace's key domain. */
		const en = {
			panel: "Skills",
			expandSource: "Expand skills",
			collapseSource: "Collapse skills",
			expandAll: "Expand all",
			collapseAll: "Collapse all",
			expandProject: "Expand project skills",
			collapseProject: "Collapse project skills",
			title: "Skills",
			subtitle: "Install skill sources, keep them current, and decide which skills this agent can use.",
			install: "Add skill source",
			installTitle: "Add a skill source",
			sourceTypeGit: "Git repository",
			sourceTypeLocal: "Local folder",
			identifierGit: "Repository address",
			identifierGitHint: "https://, ssh://, or git@host:owner/repo",
			identifierLocal: "Folder path",
			identifierLocalHint: "An absolute path or ~/… that contains a SKILL.md",
			forceLocal: "Replace an existing source with the same name",
			installStart: "Install",
			installRunning: "Installing…",
			installLog: "Command output",
			cancel: "Cancel",
			search: "Search skills",
			refresh: "Refresh",
			loading: "Loading skills…",
			emptyTitle: "No skill sources yet",
			emptyHint: "Add a Git repository or a local folder that contains at least one SKILL.md.",
			emptyFiltered: "No skill matches this search.",
			countSources: "{count} sources",
			countSkills: "{count} skills",
			update: "Update",
			updating: "Updating…",
			remove: "Remove",
			removeTitle: "Remove this skill source?",
			removeMessage: "This deletes “{slug}” and every skill it provides from the skill library.",
			removeConfirm: "Remove",
			enabled: "Enabled",
			disabled: "Disabled",
			enableSource: "Enable every skill in this source",
			disableSource: "Disable every skill in this source",
			invalid: "Invalid",
			modelOnly: "Model only",
			userOnly: "User only",
			noSkills: "No valid skill in this source.",
			version: "Version {version}",
			note: "Note",
			updateSucceeded: "Updated {slug}.",
			removedSucceeded: "Removed {slug}.",
			installedSucceeded: "Added {slug}.",
			failed: "The request failed: {message}",
			retry: "Retry",
			close: "Close",
			skillPath: "Skill folder",
			link: "Link to project",
			selectProjects: "Choose projects",
			customProjectPath: "Add a custom project path",
			addProject: "Add",
			removeProject: "Remove project",
			linkSucceededProjects: "Linked {count} position(s) into {projects}.",
			scan: "Scan installed skills",
			scanTitle: "Import skills installed by other agents",
			scanSubtitle: "The scan only reads these directories; importing copies a skill into the library and records where it came from.",
			scanLoading: "Scanning…",
			scanSearch: "Search scanned skills",
			scanEmpty: "No installed skill was found in the scanned directories.",
			scanRoots: "Scanned roots",
			scanRootsSummary: "{exists}/{total} scanned roots exist",
			scanRootsExists: "scanned",
			scanRootsHint: "Missing roots are skipped. Add more with scanSkillDirs.",
			scanGroupEmpty: "no skill found",
			scanMissingRoot: "missing",
			scanImportable: "Available",
			scanImported: "Imported",
			scanConflict: "Name conflict",
			scanInvalid: "Invalid",
			scanOverwrite: "Replace a conflicting copy that this manager imported earlier",
			scanOverwriteHint: "A name conflict with a skill from another source is never overwritten automatically.",
			scanImport: "Import selected",
			scanImporting: "Importing…",
			scanSelected: "{count} selected",
			scanResultImported: "Imported {count}",
			scanResultSkipped: "Already imported {count}",
			scanResultConflicts: "Conflicts {count}",
			scanResultFailed: "Failed {count}",
			scanDone: "Done",
			scanConflictDetail: "Existing: {source}",
			linkTitle: "Link “{slug}” to a project",
			linkProject: "Project directory",
			linkAgents: "Agent targets",
			linkAgentsHint: "Each selected agent receives a symlink in its own skills directory.",
			linkStart: "Link",
			linking: "Linking…",
			projectRequired: "Choose or type a project directory first.",
			agentsRequired: "Select at least one agent.",
			linkedProjects: "Linked projects",
			resync: "Resync",
			unlinkAll: "Unlink all",
			projectMissing: "This project directory no longer exists; the record is kept so it can be repaired.",
			linkStateLinked: "linked",
			linkStateMissing: "missing",
			linkStateBroken: "broken",
			linkStateConflict: "conflict",
			linkStateExternal: "external",
			linkUnlinked: "Unlinked every recorded skill from {project}.",
			linkResynced: "Resynced {project}.",
			linkSkipped: "Positions occupied by other files or foreign links stay untouched.",
			agentsSearch: "Search agents",
			agentCount: "{count} agents",
			staleEntry: "This skill is no longer in the library and will be dropped on resync.",
			checkUpdates: "Check for updates",
			checking: "Checking…",
			updateAvailable: "{count} new commit(s)",
			updateCurrent: "Up to date",
			updateChecked: "Checked {time}",
			updateDirty: "Local changes",
			updateError: "Check failed: {message}",
			linkSkill: "Link",
			unlinkOne: "Unlink",
			linkOneSucceeded: "Linked {skill} into {project}."
		};
		/** Chinese dictionary, complete against {@link en}. */
		const zh = {
			panel: "技能",
			expandSource: "展开技能列表",
			collapseSource: "收起技能列表",
			expandAll: "全部展开",
			collapseAll: "全部收起",
			expandProject: "展开该项目的技能",
			collapseProject: "收起该项目的技能",
			title: "技能",
			subtitle: "安装技能来源、保持更新，并决定这个 agent 能用哪些技能。",
			install: "添加技能来源",
			installTitle: "添加技能来源",
			sourceTypeGit: "Git 仓库",
			sourceTypeLocal: "本地目录",
			identifierGit: "仓库地址",
			identifierGitHint: "https://、ssh:// 或 git@host:owner/repo",
			identifierLocal: "目录路径",
			identifierLocalHint: "包含 SKILL.md 的绝对路径或 ~/… 路径",
			forceLocal: "覆盖同名的已有来源",
			installStart: "安装",
			installRunning: "正在安装…",
			installLog: "命令输出",
			cancel: "取消",
			search: "搜索技能",
			refresh: "刷新",
			loading: "正在加载技能…",
			emptyTitle: "还没有技能来源",
			emptyHint: "添加一个包含至少一个 SKILL.md 的 Git 仓库或本地目录。",
			emptyFiltered: "没有匹配的技能。",
			countSources: "{count} 个来源",
			countSkills: "{count} 个技能",
			update: "更新",
			updating: "正在更新…",
			remove: "删除",
			removeTitle: "删除这个技能来源？",
			removeMessage: "将把「{slug}」及其提供的全部技能从技能库中删除。",
			removeConfirm: "删除",
			enabled: "已启用",
			disabled: "已停用",
			enableSource: "启用该来源的全部技能",
			disableSource: "停用该来源的全部技能",
			invalid: "无效",
			modelOnly: "仅模型",
			userOnly: "仅用户",
			noSkills: "该来源没有有效技能。",
			version: "版本 {version}",
			note: "备注",
			updateSucceeded: "已更新 {slug}。",
			removedSucceeded: "已删除 {slug}。",
			installedSucceeded: "已添加 {slug}。",
			failed: "请求失败：{message}",
			retry: "重试",
			close: "关闭",
			skillPath: "技能目录",
			link: "关联到项目",
			selectProjects: "选择项目",
			customProjectPath: "添加自定义项目路径",
			addProject: "添加",
			removeProject: "移除项目",
			linkSucceededProjects: "已向 {projects} 写入 {count} 个链接位置。",
			scan: "扫描已安装技能",
			scanTitle: "导入其它 agent 已安装的技能",
			scanSubtitle: "扫描只读取这些目录；导入会把技能复制进技能库，并记录来源。",
			scanLoading: "正在扫描…",
			scanSearch: "搜索扫描结果",
			scanEmpty: "这些目录里没有发现已安装的技能。",
			scanRoots: "扫描目录",
			scanRootsSummary: "扫描目录：{exists}/{total} 个存在",
			scanRootsExists: "已扫描",
			scanRootsHint: "不存在的目录会跳过；可用 scanSkillDirs 追加。",
			scanGroupEmpty: "未发现技能",
			scanMissingRoot: "不存在",
			scanImportable: "可导入",
			scanImported: "已导入",
			scanConflict: "同名冲突",
			scanInvalid: "无效",
			scanOverwrite: "覆盖此前由本插件导入的同名副本",
			scanOverwriteHint: "与其它来源的同名技能冲突时不会自动覆盖。",
			scanImport: "导入所选",
			scanImporting: "正在导入…",
			scanSelected: "已选 {count} 个",
			scanResultImported: "已导入 {count}",
			scanResultSkipped: "已存在 {count}",
			scanResultConflicts: "冲突 {count}",
			scanResultFailed: "失败 {count}",
			scanDone: "完成",
			scanConflictDetail: "现有：{source}",
			linkTitle: "把「{slug}」关联到项目",
			linkProject: "项目目录",
			linkAgents: "目标 agent",
			linkAgentsHint: "每个选中的 agent 会在自己的 skills 目录收到一个软链。",
			linkStart: "关联",
			linking: "正在关联…",
			projectRequired: "请先选择或输入项目目录。",
			agentsRequired: "至少选择一个 agent。",
			linkedProjects: "已关联项目",
			resync: "重新同步",
			unlinkAll: "全部取消",
			projectMissing: "该项目目录已不存在；记录仍保留，便于修复。",
			linkStateLinked: "已关联",
			linkStateMissing: "缺失",
			linkStateBroken: "断链",
			linkStateConflict: "冲突",
			linkStateExternal: "外部",
			linkUnlinked: "已取消 {project} 的全部关联。",
			linkResynced: "已重新同步 {project}。",
			linkSkipped: "被其它文件或外部软链占用的位置保持不动。",
			agentsSearch: "搜索 agent",
			agentCount: "{count} 个 agent",
			staleEntry: "该技能已不在技能库中，重新同步时会被清理。",
			checkUpdates: "检查更新",
			checking: "正在检查…",
			updateAvailable: "有 {count} 个新提交",
			updateCurrent: "已是最新",
			updateChecked: "检查于 {time}",
			updateDirty: "有本地改动",
			updateError: "检查失败：{message}",
			linkSkill: "关联",
			unlinkOne: "取消",
			linkOneSucceeded: "已把 {skill} 关联到 {project}。"
		};
		// src/client/index.tsx
		const name = "skills-manager";
		const inject = ["slots", "locale"];
		/** Main-panel id: the sidebar row id and the keyed `main` registration share it. */
		const PANEL_ID = LOCALE_NAMESPACE;
		/**
		* Register the locale dictionaries and the Plugins-page tab.
		* @param ctx - browser-side plugin context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, {
				en,
				zh
			}), "skills-manager: dictionaries");
			const bound = ctx.locale.bind(LOCALE_NAMESPACE);
			const t = (key, params) => bound(key, params);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: LOCALE_NAMESPACE
			}, SkillsPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => t("panel"),
				locale: LOCALE_NAMESPACE
			}, SkillsPanelIcon));
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
