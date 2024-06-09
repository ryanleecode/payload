/* eslint-disable no-param-reassign */
import type { Relation } from 'drizzle-orm'
import type { IndexBuilder, PgColumnBuilder } from 'drizzle-orm/pg-core'
import type { Field, TabAsField } from 'payload/types'

import { relations } from 'drizzle-orm'
import {
  PgNumericBuilder,
  PgUUIDBuilder,
  PgVarcharBuilder,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { InvalidConfiguration } from 'payload/errors'
import { fieldAffectsData, optionIsObject } from 'payload/types'
import toSnakeCase from 'to-snake-case'

import type { GenericColumns, IDType, PostgresAdapter } from '../types.js'
import type { BaseExtraConfig, RelationMap } from './build.js'

import { hasLocalesTable } from '../utilities/hasLocalesTable.js'
import { buildTable } from './build.js'
import { createIndex } from './createIndex.js'
import { createTableName } from './createTableName.js'
import { idToUUID } from './idToUUID.js'
import { parentIDColumnMap } from './parentIDColumnMap.js'
import { validateExistingBlockIsIdentical } from './validateExistingBlockIsIdentical.js'

type Args = {
  adapter: PostgresAdapter
  columnPrefix?: string
  columns: Record<string, PgColumnBuilder>
  disableNotNull: boolean
  disableUnique?: boolean
  fieldPrefix?: string
  fields: (Field | TabAsField)[]
  forceLocalized?: boolean
  indexes: Record<string, (cols: GenericColumns) => IndexBuilder>
  localesColumns: Record<string, PgColumnBuilder>
  localesIndexes: Record<string, (cols: GenericColumns) => IndexBuilder>
  newTableName: string
  parentTableName: string
  relationsToBuild: RelationMap
  relationships: Set<string>
  rootRelationsToBuild?: RelationMap
  rootTableIDColType: string
  rootTableName: string
  versions: boolean
}

type Result = {
  hasLocalizedField: boolean
  hasLocalizedManyNumberField: boolean
  hasLocalizedManyTextField: boolean
  hasLocalizedRelationshipField: boolean
  hasManyNumberField: 'index' | boolean
  hasManyTextField: 'index' | boolean
}

export const traverseFields = ({
  adapter,
  columnPrefix,
  columns,
  disableNotNull,
  disableUnique = false,
  fieldPrefix,
  fields,
  forceLocalized,
  indexes,
  localesColumns,
  localesIndexes,
  newTableName,
  parentTableName,
  relationsToBuild,
  relationships,
  rootRelationsToBuild,
  rootTableIDColType,
  rootTableName,
  versions,
}: Args): Result => {
  const throwValidationError = true
  let hasLocalizedField = false
  let hasLocalizedRelationshipField = false
  let hasManyTextField: 'index' | boolean = false
  let hasLocalizedManyTextField = false
  let hasManyNumberField: 'index' | boolean = false
  let hasLocalizedManyNumberField = false

  let parentIDColType: IDType = 'integer'
  if (columns.id instanceof PgUUIDBuilder) parentIDColType = 'uuid'
  if (columns.id instanceof PgNumericBuilder) parentIDColType = 'numeric'
  if (columns.id instanceof PgVarcharBuilder) parentIDColType = 'varchar'

  fields.forEach((field) => {
    if ('name' in field && field.name === 'id') return
    let columnName: string
    let fieldName: string

    let targetTable = columns
    let targetIndexes = indexes

    if (fieldAffectsData(field)) {
      columnName = `${columnPrefix || ''}${field.name[0] === '_' ? '_' : ''}${toSnakeCase(
        field.name,
      )}`
      fieldName = `${fieldPrefix?.replace('.', '_') || ''}${field.name}`

      // If field is localized,
      // add the column to the locale table instead of main table
      if (
        adapter.payload.config.localization &&
        (field.localized || forceLocalized) &&
        field.type !== 'array' &&
        field.type !== 'blocks' &&
        (('hasMany' in field && field.hasMany !== true) || !('hasMany' in field))
      ) {
        hasLocalizedField = true
        targetTable = localesColumns
        targetIndexes = localesIndexes
      }

      if (
        (field.unique || field.index) &&
        !['array', 'blocks', 'group', 'point', 'relationship', 'upload'].includes(field.type) &&
        !('hasMany' in field && field.hasMany === true)
      ) {
        const unique = disableUnique !== true && field.unique
        if (unique) {
          const constraintValue = `${fieldPrefix || ''}${field.name}`
          if (!adapter.fieldConstraints?.[rootTableName]) {
            adapter.fieldConstraints[rootTableName] = {}
          }
          adapter.fieldConstraints[rootTableName][`${columnName}_idx`] = constraintValue
        }
        targetIndexes[`${newTableName}_${field.name}Idx`] = createIndex({
          name: fieldName,
          columnName,
          tableName: newTableName,
          unique,
        })
      }
    }

    switch (field.type) {
      case 'text': {
        if (field.hasMany) {
          if (field.localized) {
            hasLocalizedManyTextField = true
          }

          if (field.index) {
            hasManyTextField = 'index'
          } else if (!hasManyTextField) {
            hasManyTextField = true
          }

          if (field.unique) {
            throw new InvalidConfiguration(
              'Unique is not supported in Postgres for hasMany text fields.',
            )
          }
        } else {
          targetTable[fieldName] = varchar(columnName).default(field.defaultValue)
        }
        break
      }
      case 'email':
      case 'code':
      case 'textarea': {
        targetTable[fieldName] = varchar(columnName).default(field.defaultValue)
        break
      }

      case 'number': {
        if (field.hasMany) {
          if (field.localized) {
            hasLocalizedManyNumberField = true
          }

          if (field.index) {
            hasManyNumberField = 'index'
          } else if (!hasManyNumberField) {
            hasManyNumberField = true
          }

          if (field.unique) {
            throw new InvalidConfiguration(
              'Unique is not supported in Postgres for hasMany number fields.',
            )
          }
        } else {
          targetTable[fieldName] = numeric(columnName).default(field.defaultValue)
        }
        break
      }

      case 'richText':
      case 'json': {
        targetTable[fieldName] = jsonb(columnName).default(field.defaultValue)
        break
      }

      case 'date': {
        targetTable[fieldName] = timestamp(columnName, {
          mode: 'string',
          precision: 3,
          withTimezone: true,
        }).default(field.defaultValue)
        break
      }

      case 'point': {
        break
      }

      case 'radio':
      case 'select': {
        const enumName = createTableName({
          adapter,
          config: field,
          parentTableName: newTableName,
          prefix: `enum_${newTableName}_`,
          target: 'enumName',
          throwValidationError,
        })

        adapter.enums[enumName] = pgEnum(
          enumName,
          field.options.map((option) => {
            if (optionIsObject(option)) {
              return option.value
            }

            return option
          }) as [string, ...string[]],
        )

        if (field.type === 'select' && field.hasMany) {
          const selectTableName = createTableName({
            adapter,
            config: field,
            parentTableName: newTableName,
            prefix: `${newTableName}_`,
            throwValidationError,
            versionsCustomName: versions,
          })
          const baseColumns: Record<string, PgColumnBuilder> = {
            order: integer('order').notNull(),
            parent: parentIDColumnMap[parentIDColType]('parent_id').notNull(),
            value: adapter.enums[enumName]('value'),
          }

          const baseExtraConfig: BaseExtraConfig = {
            orderIdx: (cols) => index(`${selectTableName}_order_idx`).on(cols.order),
            parentFk: (cols) =>
              foreignKey({
                name: `${selectTableName}_parent_fk`,
                columns: [cols.parent],
                foreignColumns: [adapter.tables[parentTableName].id],
              }).onDelete('cascade'),
            parentIdx: (cols) => index(`${selectTableName}_parent_idx`).on(cols.parent),
          }

          if (field.localized) {
            baseColumns.locale = adapter.enums.enum__locales('locale').notNull()
            baseExtraConfig.localeIdx = (cols) =>
              index(`${selectTableName}_locale_idx`).on(cols.locale)
          }

          if (field.index) {
            baseExtraConfig.value = (cols) => index(`${selectTableName}_value_idx`).on(cols.value)
          }

          buildTable({
            adapter,
            baseColumns,
            baseExtraConfig,
            disableNotNull,
            disableUnique,
            fields: [],
            rootTableName,
            tableName: selectTableName,
            versions,
          })

          relationsToBuild.set(fieldName, {
            type: 'many',
            // selects have their own localized table, independent of the base table.
            localized: false,
            target: selectTableName,
          })

          adapter.relations[`relations_${selectTableName}`] = relations(
            adapter.tables[selectTableName],
            ({ one }) => ({
              parent: one(adapter.tables[parentTableName], {
                fields: [adapter.tables[selectTableName].parent],
                references: [adapter.tables[parentTableName].id],
                relationName: fieldName,
              }),
            }),
          )
        } else {
          targetTable[fieldName] = adapter.enums[enumName](fieldName)
        }
        break
      }

      case 'checkbox': {
        targetTable[fieldName] = boolean(columnName)
        break
      }

      case 'array': {
        const disableNotNullFromHere = Boolean(field.admin?.condition) || disableNotNull

        const arrayTableName = createTableName({
          adapter,
          config: field,
          parentTableName: newTableName,
          prefix: `${newTableName}_`,
          throwValidationError,
          versionsCustomName: versions,
        })

        const baseColumns: Record<string, PgColumnBuilder> = {
          _order: integer('_order').notNull(),
          _parentID: parentIDColumnMap[parentIDColType]('_parent_id').notNull(),
        }

        const baseExtraConfig: BaseExtraConfig = {
          _orderIdx: (cols) => index(`${arrayTableName}_order_idx`).on(cols._order),
          _parentIDFk: (cols) =>
            foreignKey({
              name: `${arrayTableName}_parent_id_fk`,
              columns: [cols['_parentID']],
              foreignColumns: [adapter.tables[parentTableName].id],
            }).onDelete('cascade'),
          _parentIDIdx: (cols) => index(`${arrayTableName}_parent_id_idx`).on(cols._parentID),
        }

        if (field.localized && adapter.payload.config.localization) {
          baseColumns._locale = adapter.enums.enum__locales('_locale').notNull()
          baseExtraConfig._localeIdx = (cols) =>
            index(`${arrayTableName}_locale_idx`).on(cols._locale)
        }

        const {
          hasManyNumberField: subHasManyNumberField,
          hasManyTextField: subHasManyTextField,
          relationsToBuild: subRelationsToBuild,
        } = buildTable({
          adapter,
          baseColumns,
          baseExtraConfig,
          disableNotNull: disableNotNullFromHere,
          disableUnique,
          fields: disableUnique ? idToUUID(field.fields) : field.fields,
          rootRelationsToBuild,
          rootRelationships: relationships,
          rootTableIDColType,
          rootTableName,
          tableName: arrayTableName,
          versions,
        })

        if (subHasManyTextField) {
          if (!hasManyTextField || subHasManyTextField === 'index')
            hasManyTextField = subHasManyTextField
        }
        if (subHasManyNumberField) {
          if (!hasManyNumberField || subHasManyNumberField === 'index')
            hasManyNumberField = subHasManyNumberField
        }

        relationsToBuild.set(fieldName, {
          type: 'many',
          // arrays have their own localized table, independent of the base table.
          localized: false,
          target: arrayTableName,
        })

        adapter.relations[`relations_${arrayTableName}`] = relations(
          adapter.tables[arrayTableName],
          ({ many, one }) => {
            const result: Record<string, Relation<string>> = {
              _parentID: one(adapter.tables[parentTableName], {
                fields: [adapter.tables[arrayTableName]._parentID],
                references: [adapter.tables[parentTableName].id],
                relationName: fieldName,
              }),
            }

            if (hasLocalesTable(field.fields)) {
              result._locales = many(adapter.tables[`${arrayTableName}${adapter.localesSuffix}`], {
                relationName: '_locales',
              })
            }

            subRelationsToBuild.forEach(({ type, localized, target }, key) => {
              if (type === 'one') {
                const arrayWithLocalized = localized
                  ? `${arrayTableName}${adapter.localesSuffix}`
                  : arrayTableName
                result[key] = one(adapter.tables[target], {
                  fields: [adapter.tables[arrayWithLocalized][key]],
                  references: [adapter.tables[target].id],
                  relationName: key,
                })
              }
              if (type === 'many') {
                result[key] = many(adapter.tables[target], { relationName: key })
              }
            })

            return result
          },
        )

        break
      }

      case 'blocks': {
        const disableNotNullFromHere = Boolean(field.admin?.condition) || disableNotNull

        field.blocks.forEach((block) => {
          const blockTableName = createTableName({
            adapter,
            config: block,
            parentTableName: rootTableName,
            prefix: `${rootTableName}_blocks_`,
            throwValidationError,
            versionsCustomName: versions,
          })
          if (!adapter.tables[blockTableName]) {
            const baseColumns: Record<string, PgColumnBuilder> = {
              _order: integer('_order').notNull(),
              _parentID: parentIDColumnMap[rootTableIDColType]('_parent_id').notNull(),
              _path: text('_path').notNull(),
            }

            const baseExtraConfig: BaseExtraConfig = {
              _orderIdx: (cols) => index(`${blockTableName}_order_idx`).on(cols._order),
              _parentIDIdx: (cols) => index(`${blockTableName}_parent_id_idx`).on(cols._parentID),
              _parentIdFk: (cols) =>
                foreignKey({
                  name: `${blockTableName}_parent_id_fk`,
                  columns: [cols._parentID],
                  foreignColumns: [adapter.tables[rootTableName].id],
                }).onDelete('cascade'),
              _pathIdx: (cols) => index(`${blockTableName}_path_idx`).on(cols._path),
            }

            if (field.localized && adapter.payload.config.localization) {
              baseColumns._locale = adapter.enums.enum__locales('_locale').notNull()
              baseExtraConfig._localeIdx = (cols) =>
                index(`${blockTableName}_locale_idx`).on(cols._locale)
            }

            const {
              hasManyNumberField: subHasManyNumberField,
              hasManyTextField: subHasManyTextField,
              relationsToBuild: subRelationsToBuild,
            } = buildTable({
              adapter,
              baseColumns,
              baseExtraConfig,
              disableNotNull: disableNotNullFromHere,
              disableUnique,
              fields: disableUnique ? idToUUID(block.fields) : block.fields,
              rootRelationsToBuild,
              rootRelationships: relationships,
              rootTableIDColType,
              rootTableName,
              tableName: blockTableName,
              versions,
            })

            if (subHasManyTextField) {
              if (!hasManyTextField || subHasManyTextField === 'index')
                hasManyTextField = subHasManyTextField
            }

            if (subHasManyNumberField) {
              if (!hasManyNumberField || subHasManyNumberField === 'index')
                hasManyNumberField = subHasManyNumberField
            }

            adapter.relations[`relations_${blockTableName}`] = relations(
              adapter.tables[blockTableName],
              ({ many, one }) => {
                const result: Record<string, Relation<string>> = {
                  _parentID: one(adapter.tables[rootTableName], {
                    fields: [adapter.tables[blockTableName]._parentID],
                    references: [adapter.tables[rootTableName].id],
                    relationName: `_blocks_${block.slug}`,
                  }),
                }

                if (hasLocalesTable(block.fields)) {
                  result._locales = many(
                    adapter.tables[`${blockTableName}${adapter.localesSuffix}`],
                    { relationName: '_locales' },
                  )
                }

                subRelationsToBuild.forEach(({ type, localized, target }, key) => {
                  if (type === 'one') {
                    const blockWithLocalized = localized
                      ? `${blockTableName}${adapter.localesSuffix}`
                      : blockTableName
                    result[key] = one(adapter.tables[target], {
                      fields: [adapter.tables[blockWithLocalized][key]],
                      references: [adapter.tables[target].id],
                      relationName: key,
                    })
                  }
                  if (type === 'many') {
                    result[key] = many(adapter.tables[target], { relationName: key })
                  }
                })

                return result
              },
            )
          } else if (process.env.NODE_ENV !== 'production' && !versions) {
            validateExistingBlockIsIdentical({
              block,
              localized: field.localized,
              rootTableName,
              table: adapter.tables[blockTableName],
              tableLocales: adapter.tables[`${blockTableName}${adapter.localesSuffix}`],
            })
          }
          // blocks relationships are defined from the collection or globals table down to the block, bypassing any subBlocks
          rootRelationsToBuild.set(`_blocks_${block.slug}`, {
            type: 'many',
            // blocks are not localized on the parent table
            localized: false,
            target: blockTableName,
          })
        })

        break
      }

      case 'tab':
      case 'group': {
        if (!('name' in field)) {
          const {
            hasLocalizedField: groupHasLocalizedField,
            hasLocalizedManyNumberField: groupHasLocalizedManyNumberField,
            hasLocalizedManyTextField: groupHasLocalizedManyTextField,
            hasLocalizedRelationshipField: groupHasLocalizedRelationshipField,
            hasManyNumberField: groupHasManyNumberField,
            hasManyTextField: groupHasManyTextField,
          } = traverseFields({
            adapter,
            columnPrefix,
            columns,
            disableNotNull,
            disableUnique,
            fieldPrefix,
            fields: field.fields,
            forceLocalized,
            indexes,
            localesColumns,
            localesIndexes,
            newTableName,
            parentTableName,
            relationsToBuild,
            relationships,
            rootRelationsToBuild,
            rootTableIDColType,
            rootTableName,
            versions,
          })

          if (groupHasLocalizedField) hasLocalizedField = true
          if (groupHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
          if (groupHasManyTextField) hasManyTextField = true
          if (groupHasLocalizedManyTextField) hasLocalizedManyTextField = true
          if (groupHasManyNumberField) hasManyNumberField = true
          if (groupHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
          break
        }

        const disableNotNullFromHere = Boolean(field.admin?.condition) || disableNotNull

        const {
          hasLocalizedField: groupHasLocalizedField,
          hasLocalizedManyNumberField: groupHasLocalizedManyNumberField,
          hasLocalizedManyTextField: groupHasLocalizedManyTextField,
          hasLocalizedRelationshipField: groupHasLocalizedRelationshipField,
          hasManyNumberField: groupHasManyNumberField,
          hasManyTextField: groupHasManyTextField,
        } = traverseFields({
          adapter,
          columnPrefix: `${columnName}_`,
          columns,
          disableNotNull: disableNotNullFromHere,
          disableUnique,
          fieldPrefix: `${fieldName}.`,
          fields: field.fields,
          forceLocalized: field.localized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName: `${parentTableName}_${columnName}`,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
          versions,
        })

        if (groupHasLocalizedField) hasLocalizedField = true
        if (groupHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (groupHasManyTextField) hasManyTextField = true
        if (groupHasLocalizedManyTextField) hasLocalizedManyTextField = true
        if (groupHasManyNumberField) hasManyNumberField = true
        if (groupHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
        break
      }

      case 'tabs': {
        const disableNotNullFromHere = Boolean(field.admin?.condition) || disableNotNull

        const {
          hasLocalizedField: tabHasLocalizedField,
          hasLocalizedManyNumberField: tabHasLocalizedManyNumberField,
          hasLocalizedManyTextField: tabHasLocalizedManyTextField,
          hasLocalizedRelationshipField: tabHasLocalizedRelationshipField,
          hasManyNumberField: tabHasManyNumberField,
          hasManyTextField: tabHasManyTextField,
        } = traverseFields({
          adapter,
          columnPrefix,
          columns,
          disableNotNull: disableNotNullFromHere,
          disableUnique,
          fieldPrefix,
          fields: field.tabs.map((tab) => ({ ...tab, type: 'tab' })),
          forceLocalized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
          versions,
        })

        if (tabHasLocalizedField) hasLocalizedField = true
        if (tabHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (tabHasManyTextField) hasManyTextField = true
        if (tabHasLocalizedManyTextField) hasLocalizedManyTextField = true
        if (tabHasManyNumberField) hasManyNumberField = true
        if (tabHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
        break
      }

      case 'row':
      case 'collapsible': {
        const disableNotNullFromHere = Boolean(field.admin?.condition) || disableNotNull
        const {
          hasLocalizedField: rowHasLocalizedField,
          hasLocalizedManyNumberField: rowHasLocalizedManyNumberField,
          hasLocalizedManyTextField: rowHasLocalizedManyTextField,
          hasLocalizedRelationshipField: rowHasLocalizedRelationshipField,
          hasManyNumberField: rowHasManyNumberField,
          hasManyTextField: rowHasManyTextField,
        } = traverseFields({
          adapter,
          columnPrefix,
          columns,
          disableNotNull: disableNotNullFromHere,
          disableUnique,
          fieldPrefix,
          fields: field.fields,
          forceLocalized,
          indexes,
          localesColumns,
          localesIndexes,
          newTableName,
          parentTableName,
          relationsToBuild,
          relationships,
          rootRelationsToBuild,
          rootTableIDColType,
          rootTableName,
          versions,
        })

        if (rowHasLocalizedField) hasLocalizedField = true
        if (rowHasLocalizedRelationshipField) hasLocalizedRelationshipField = true
        if (rowHasManyTextField) hasManyTextField = true
        if (rowHasLocalizedManyTextField) hasLocalizedManyTextField = true
        if (rowHasManyNumberField) hasManyNumberField = true
        if (rowHasLocalizedManyNumberField) hasLocalizedManyNumberField = true
        break
      }

      case 'relationship':
      case 'upload':
        if (Array.isArray(field.relationTo)) {
          field.relationTo.forEach((relation) => relationships.add(relation))
        } else if (field.type === 'relationship' && field.hasMany) {
          relationships.add(field.relationTo)
        } else {
          // simple relationships get a column on the targetTable with a foreign key to the relationTo table
          const relationshipConfig = adapter.payload.collections[field.relationTo].config

          const tableName = adapter.tableNameMap.get(toSnakeCase(field.relationTo))

          // get the id type of the related collection
          let colType = adapter.idType === 'uuid' ? 'uuid' : 'integer'
          const relatedCollectionCustomID = relationshipConfig.fields.find(
            (field) => fieldAffectsData(field) && field.name === 'id',
          )
          if (relatedCollectionCustomID?.type === 'number') colType = 'numeric'
          if (relatedCollectionCustomID?.type === 'text') colType = 'varchar'

          // make the foreign key column for relationship using the correct id column type
          targetTable[fieldName] = parentIDColumnMap[colType](`${columnName}_id`).references(
            () => adapter.tables[tableName].id,
            { onDelete: 'set null' },
          )

          // add relationship to table
          relationsToBuild.set(fieldName, {
            type: 'one',
            localized: adapter.payload.config.localization && field.localized,
            target: tableName,
          })

          // add notNull when not required
          if (!disableNotNull && field.required && !field.admin?.condition) {
            targetTable[fieldName].notNull()
          }
          break
        }
        if (adapter.payload.config.localization && field.localized) {
          hasLocalizedRelationshipField = true
        }

        break

      default:
        break
    }

    const condition = field.admin && field.admin.condition

    if (
      !disableNotNull &&
      targetTable[fieldName] &&
      'required' in field &&
      field.required &&
      !condition
    ) {
      targetTable[fieldName].notNull()
    }
  })

  return {
    hasLocalizedField,
    hasLocalizedManyNumberField,
    hasLocalizedManyTextField,
    hasLocalizedRelationshipField,
    hasManyNumberField,
    hasManyTextField,
  }
}
