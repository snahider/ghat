'use strict';
const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const yaml = require('js-yaml');
const degit = require('degit');
const dotProp = require('dot-prop');
const {outdent} = require('outdent');

class InputError extends Error {}

async function loadYamlFile(path) {
	const string = await fs.readFile(path, 'utf8').catch(() => '');
	return {
		string,
		parsed: string ? yaml.safeLoad(string) : {}
	};
}

async function findYamlFiles(path) {
	try {
		const contents = await fs.readdir(path);
		return contents.filter(filename => /\.ya?ml$/.test(filename));
	} catch (error) {
		if (error.message.startsWith('ENOENT')) {
			return [];
		}

		throw error;
	}
}

async function getWorkflows(directory) {
	// Expect to find workflows in the specified folder or "workflow template repo"
	const local = await findYamlFiles(directory);
	if (local.length > 0) {
		return local;
	}

	// If not, the user probably wants to copy workflows from a regular repo
	return findYamlFiles(path.join(directory, '.github/workflows'));
}

async function ghat(source, {exclude, command}) {
	if (!source) {
		throw new InputError('No source was specified');
	}

	const getter = degit(source, {
		force: true,
		verbose: true
	});

	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ghat-'));
	const file = getter.repo.subdir && path.parse(getter.repo.subdir);

	// If `source` points to a file, .clone() must receive a path to the file
	const destination = file?.ext ? path.join(temporaryDirectory, file.base) : temporaryDirectory;
	await getter.clone(destination);

	const templates = await getWorkflows(temporaryDirectory);
	if (templates.length === 0) {
		throw new InputError('No workflows found in ' + source);
	}

	await fs.mkdir('.github/workflows', {recursive: true});

	const applyTemplate = async filename => {
		const localWorkflowPath = path.join('.github/workflows', path.basename(filename));
		const remoteWorkflowPath = path.join(temporaryDirectory, filename);
		const [local, remote] = await Promise.all([
			loadYamlFile(localWorkflowPath),
			loadYamlFile(remoteWorkflowPath)
		]);

		// Merge ENV objects if any, allowing the local to override the remote
		const env = {...remote.parsed.env, ...local.parsed?.env};

		// If the remote has any ENVs, they need to be dropped
		if (remote.parsed.env && Object.keys(remote.parsed.env).length > 0) {
			delete remote.parsed.env;
			remote.string = yaml.safeDump(remote.parsed, {noCompatMode: true});
		}

		if (exclude.length > 0) {
			for (const path of exclude) {
				dotProp.delete(remote.parsed, path);
			}

			remote.string = yaml.safeDump(remote.parsed, {noCompatMode: true});
		}

		await fs.writeFile(localWorkflowPath, outdent`
			${yaml.safeDump({env})}
			# DO NOT EDIT BELOW - use \`npx ghat ${command}\`

			${await remote.string}`
		);
	};

	await Promise.all(templates.map(filename => applyTemplate(filename)));
}

module.exports = ghat;
module.exports.InputError = InputError;
