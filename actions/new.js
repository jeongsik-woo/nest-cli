const Schematic = require('../schematics/schematic');
const SchematicRunner = require('../schematics/runner');

module.exports = (args, options, logger) => {
  const runner = new SchematicRunner(logger);
  const builder = Schematic
    .Builder()
    .withCollectionName('.')
    .withSchematicName('application')
    .withArgs(args)
    .withOptions(options);
  runner.run(builder.build());
};