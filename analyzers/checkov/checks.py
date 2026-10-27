# Build time: dump {check id: {name, categories}} for the frameworks we run,
# since checkov offline reports no severity or category of its own.
import json
import sys

from checkov.arm.registry import arm_resource_registry, arm_parameter_registry
from checkov.bicep.checks.param.registry import registry as bicep_param_registry
from checkov.bicep.checks.resource.registry import registry as bicep_resource_registry
from checkov.cloudformation.checks.resource.registry import cfn_registry
from checkov.common.checks_infra.registry import get_graph_checks_registry
from checkov.serverless.registry import sls_registry
from checkov.terraform.checks.data.registry import data_registry
from checkov.terraform.checks.module.registry import module_registry
from checkov.terraform.checks.provider.registry import provider_registry
from checkov.terraform.checks.resource.registry import resource_registry

checks = {}
for registry in [resource_registry, data_registry, module_registry, provider_registry, cfn_registry, arm_resource_registry, arm_parameter_registry, bicep_resource_registry, bicep_param_registry, sls_registry]:
    for group in registry.checks.values():
        for c in group:
            checks[c.id] = {'name': c.name, 'categories': sorted(cat.name for cat in c.categories)}
for framework in ['terraform', 'cloudformation', 'arm', 'bicep']:
    graph = get_graph_checks_registry(framework)
    graph.load_checks()
    for c in graph.checks:
        checks.setdefault(c.id, {'name': c.name, 'categories': [c.category] if c.category else []})

with open(sys.argv[1], 'w', encoding='utf-8') as out:
    json.dump(checks, out, indent=0, sort_keys=True)
print(f'{len(checks)} checks')
