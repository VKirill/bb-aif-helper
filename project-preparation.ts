export const preparationCommands: Record<string, { skill: string; args?: string; icon: string }> = {
  architecture: { skill: 'aif-architecture', icon: 'Layers' },
  roadmap: { skill: 'aif-roadmap', icon: 'Map' },
  quality: { skill: 'aif-quality-setup', args: ' setup', icon: 'ListChecks' },
  ci: { skill: 'aif-ci', icon: 'Workflow' },
  rules: { skill: 'aif-rules', icon: 'ScrollText' },
  docs: { skill: 'aif-docs', icon: 'BookOpen' },
  build: { skill: 'aif-build-automation', icon: 'Hammer' },
  docker: { skill: 'aif-dockerize', icon: 'Box' },
};
