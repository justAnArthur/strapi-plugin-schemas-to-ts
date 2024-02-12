import { Strapi } from '@strapi/strapi'
import fs from 'fs'
import { pascalCase } from "pascal-case"
import path from 'path'
import { PluginConfig } from '../models/pluginConfig'
import { SchemaInfo } from "../models/schemaInfo"
import { SchemaSource } from '../models/schemaSource'
import { pluginName } from '../register'
import { CommonHelpers } from './commonHelpers'
import { FileHelpers } from './fileHelpers'
import { InterfaceBuilder } from './interface-builders/interfaceBuilder'
import { InterfaceBuilderFactory } from './interface-builders/interfaceBuilderFactory'

export class Converter {
  private readonly componentInterfacesFolderName: string = 'interfaces'
  private commonFolderModelsPath: string = ''
  private readonly commonHelpers: CommonHelpers
  private readonly interfaceBuilder: InterfaceBuilder
  private readonly config: PluginConfig

  constructor(strapi: Strapi, config: PluginConfig) {
    this.config = config
    this.commonHelpers = new CommonHelpers(config)
    this.interfaceBuilder = InterfaceBuilderFactory.getInterfaceBuilder(strapi, this.commonHelpers, config)
    this.commonHelpers.logger.verbose(`${pluginName} configuration`, this.config)
  }

  public SchemasToTs(): void {
    const currentNodeEnv: string = process.env.NODE_ENV ?? ''
    const acceptedNodeEnvs = this.config.acceptedNodeEnvs ?? []
    if (!acceptedNodeEnvs.includes(currentNodeEnv)) {
      this.commonHelpers.logger
        .information(`${pluginName} plugin's acceptedNodeEnvs property does not include '${currentNodeEnv}' environment. Skipping conversion of schemas to Typescript.`)
      return
    }

    this.setCommonInterfacesFolder()

    const commonSchemas: SchemaInfo[] = this.interfaceBuilder.generateCommonSchemas(this.commonFolderModelsPath)
    const apiSchemas: SchemaInfo[] = this.getSchemas(strapi.dirs.app.api, SchemaSource.Api)
    const componentSchemas: SchemaInfo[] = this.getSchemas(strapi.dirs.app.components, SchemaSource.Component, apiSchemas)
    this.adjustComponentsWhoseNamesWouldCollide(componentSchemas)

    const schemas: SchemaInfo[] = [...apiSchemas, ...componentSchemas, ...commonSchemas]
    for (const schema of schemas.filter(x => x.source !== SchemaSource.Common)) {
      this.interfaceBuilder.convertSchemaToInterfaces(schema, schemas)
    }

    for (const schema of schemas) {
      this.writeInterfacesFile(schema)
    }

    const typesFilePath = path.join(process.cwd(), 'index.ts')

    const typesFile = '//@ts-nocheck\n' + schemas
      .map(schema => path.join(this.getFolderPath(schema), this.commonHelpers.getFileNameFromSchema(schema, true)))
      .map(filePath => `export * from "./${path.normalize(path.relative(process.cwd(), filePath)).replace(/\\/g, '/')}";`)
      .join('\n')

    fs.writeFileSync(typesFilePath, typesFile)
  }

  /**
   * A component could need the suffix and the by having it, it would end up with the same name as another one that didn't need it
   but whose name had the word 'Component' at the end
   */
  private adjustComponentsWhoseNamesWouldCollide(componentSchemas: SchemaInfo[]) {
    for (const componentSchema of componentSchemas.filter(x => x.needsComponentSuffix)) {
      const component: SchemaInfo = componentSchemas.find(x => x.pascalName === componentSchema.pascalName && !x.needsComponentSuffix)
      if (component) {
        component.needsComponentSuffix = true
        component.pascalName += 'Component'
      }
    }
  }

  private setCommonInterfacesFolder() {
    this.commonFolderModelsPath = FileHelpers.ensureFolderPathExistRecursive('common', this.config.commonInterfacesFolderName)
  }

  private getSchemas(folderPath: string, schemaSource: SchemaSource, apiSchemas?: SchemaInfo[]): SchemaInfo[] {
    const files: string[] = []

    if (FileHelpers.folderExists(folderPath)) {
      const readFolder = (folderPath: string) => {
        const items = fs.readdirSync(folderPath)
        for (const item of items) {
          const itemPath = path.join(folderPath, item)
          const stat = fs.statSync(itemPath)
          if (stat.isDirectory()) {
            readFolder(itemPath)
          } else {
            files.push(itemPath)
          }
        }
      }

      readFolder(folderPath)
    }

    return files
      .filter((file: string) => (schemaSource === SchemaSource.Api ? file.endsWith('schema.json') : file.endsWith('.json')))
      .map((file: string) => this.parseSchema(file, schemaSource, apiSchemas))
  }

  private parseSchema(file: string, schemaSource: SchemaSource, apiSchemas?: SchemaInfo[]): SchemaInfo {
    let schema: any = undefined
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      this.commonHelpers.logger.error(`Error while parsing the schema for ${file}:`, e)
    }

    let folder = ''
    let schemaName = ''

    switch (schemaSource) {
      case SchemaSource.Api:
        schemaName = schema.info.singularName
        folder = path.dirname(file)
        break
      case SchemaSource.Common:
        schemaName = schema.info.displayName
        folder = this.commonFolderModelsPath
        break
      case SchemaSource.Component:
        let fileNameWithoutExtension = path.basename(file, path.extname(file))
        schemaName = fileNameWithoutExtension
        folder = path.join(path.dirname(file), this.componentInterfacesFolderName)
        if (!FileHelpers.folderExists(folder)) {
          fs.mkdirSync(folder)
        }
        break
    }

    let pascalName: string = pascalCase(schemaName)

    let needsComponentSuffix: boolean = schemaSource === SchemaSource.Component &&
      (this.config.alwaysAddComponentSuffix || apiSchemas?.some(x => x.pascalName === pascalName))

    if (needsComponentSuffix) {
      pascalName += 'Component'
    }

    return {
      schemaPath: file,
      destinationFolder: folder,
      schema: schema,
      schemaName: schemaName,
      pascalName: pascalName,
      needsComponentSuffix: needsComponentSuffix,
      source: schemaSource,
      interfaceAsText: '',
      plainInterfaceAsText: '',
      noRelationsInterfaceAsText: '',
      adminPanelLifeCycleRelationsInterfaceAsText: '',
      dependencies: [],
      enums: []
    }
  }

  private getFolderPath(schema: SchemaInfo) {
    switch (schema.source) {
      case SchemaSource.Common:
        return this.commonFolderModelsPath
      case SchemaSource.Component:
        return schema.destinationFolder
      case SchemaSource.Api:
      default:
        return schema.destinationFolder
    }
  }

  private writeInterfacesFile(schema: SchemaInfo) {
    const interfacesFileContent = this.interfaceBuilder.buildInterfacesFileContent(schema)
    const fileName = this.commonHelpers.getFileNameFromSchema(schema, true)
    const folderPath = this.getFolderPath(schema)

    FileHelpers.writeInterfaceFile(folderPath, fileName, interfacesFileContent, this.commonHelpers.logger)
  }
}
