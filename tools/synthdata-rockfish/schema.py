# @lifespan THROWAWAY — Rockfish 0.68.0 schema: independent draws + NAMED_ENTITY_PROVIDER names.
# type->status/cost/tenure correlations live in finish.py (0.68.0 still has no CONDITIONAL_SAMPLE — spec §H).
from rockfish.actions.ent import (
    Column, ColumnType, ColumnCategoryType, DataSchema, Entity, Domain, DomainType,
    IDParams, CategoricalParams, NormalDistParams, NamedEntityProviderParams,
)
META = ColumnCategoryType.METADATA
IND = ColumnType.INDEPENDENT

def _col(name, domain, dtype="string"):
    return Column(name=name, data_type=dtype, column_type=IND, column_category_type=META, domain=domain)

def _cat(values, weights, seed):
    return Domain(type=DomainType.CATEGORICAL, params=CategoricalParams(values=values, weights=weights, seed=seed))

def _name(provider, seed):
    return Domain(type=DomainType.NAMED_ENTITY_PROVIDER,
                  params=NamedEntityProviderParams(provider=provider, locale="en", seed=seed))

def create_employee_schema(n: int) -> DataSchema:
    columns = [
        _col("employee_id", Domain(type=DomainType.ID, params=IDParams(template_str="EMP_{id}"))),
        _col("first_name", _name("person.first_name", 1)),
        _col("last_name", _name("person.last_name", 2)),
        _col("employee_type", _cat(["RFT", "RPT", "SNL"], [0.72, 0.20, 0.08], seed=10)),
        _col("sms_consent", _cat(["Y", "N"], [0.70, 0.30], seed=60)),
        _col("transitioned", _cat(["Y", "N"], [0.15, 0.85], seed=61)),
        _col("age_years", Domain(type=DomainType.NORMAL_DIST,
                                 params=NormalDistParams(mean=38.0, std=10.0, seed=40)), dtype="int64"),
    ]
    return DataSchema(entities=[Entity(name="employees", cardinality=n, columns=columns)])
