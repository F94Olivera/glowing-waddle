const express = require('express');
const bodyParser = require('body-parser');
const { sequelize } = require('./model');
const { Op } = require('sequelize');
const { getProfile } = require('./middleware/getProfile');
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize);
app.set('models', sequelize.models);

app.get('/contracts/:id', getProfile, async (req, res) => {
	const { Contract } = req.app.get('models');
	const { id } = req.params;
	const contract = await Contract.findOne({
		where: {
			id,
			[Op.or]: [
				{ contractorId: req.profile.dataValues.id },
				{ clientId: req.profile.dataValues.id },
			],
		},
	});
	if (!contract) return res.status(404).end();
	res.json(contract);
});

app.get('/contracts', getProfile, async (req, res) => {
	const { Contract } = req.app.get('models');
	const contract = await Contract.findAll({
		where: {
			[Op.not]: [{ status: 'terminated' }],
			[Op.or]: [
				{ contractorId: req.profile.dataValues.id },
				{ clientId: req.profile.dataValues.id },
			],
		},
	});
	if (!contract) return res.status(404).end();
	res.json(contract);
});

app.get('/jobs/unpaid', getProfile, async (req, res) => {
	const { Job, Contract } = req.app.get('models');
	const jobs = await Job.findAll({
		include: [
			{
				model: Contract,
				require: true,
				where: {
					status: 'in_progress',
					[Op.or]: [
						{ contractorId: req.profile.dataValues.id },
						{ clientId: req.profile.dataValues.id },
					],
				},
			},
		],
		where: {
			paid: null,
		},
	});

	if (!jobs) return res.status(404).end();
	res.json(jobs);
});

app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
	const { Job, Contract, Profile } = req.app.get('models');
	const { job_id } = req.params;
	const job = await Job.findOne({
		where: {
			id: job_id,
			paid: null,
		},
		include: [
			{
				model: Contract,
				require: true,
			},
		],
	});
	if (!job)
		return res.json({
			error: 'job not found or it has been payed already',
		});

	const clientId = job.Contract.dataValues.ClientId;
	const client = await Profile.findOne({
		where: {
			id: clientId,
		},
	});
	const contractorId = job.Contract.dataValues.ContractorId;
	const contractor = await Profile.findOne({
		where: {
			id: contractorId,
		},
	});

	if (!client) return res.json({ error: 'client not found' });
	if (!contractor) return res.json({ error: 'contractor not found' });

	const jobPrice = job.dataValues.price;
	let clientBalance = client.dataValues.balance;
	if (!clientBalance >= jobPrice)
		return res.json({ error: 'insufficient funds' });

	//update client
	clientBalance -= jobPrice;
	await Profile.update(
		{
			balance: clientBalance,
		},
		{
			where: {
				id: clientId,
			},
		}
	);

	//update contractor
	const contractorBalance = contractor.dataValues.balance + jobPrice;
	await Profile.update(
		{
			balance: contractorBalance,
		},
		{
			where: {
				id: contractorId,
			},
		}
	);

	//update job
	job.paid = 1;
	job.paymentDate = new Date();
	await job.save();

	return res.status(200).send();
});

app.post('/balances/deposit/:userId', async (req, res) => {
	try {
		const { Job, Contract, Profile } = req.app.get('models');
		const { userId } = req.params;
		const amount = parseInt(req.body.amount);
		const profile = await Profile.findOne({
			where: {
				type: 'client',
				id: userId,
			},
		});

		if (!profile)
			return res.json({ error: 'user doesnt exist' });

		const jobs = await Job.findAll({
			where: {
				paid: null,
			},
			include: [
				{
					model: Contract,
					require: true,
					where: {
						status: 'in_progress',
						clientId: userId,
					},
				},
			],
		});

		const biggestAmountToDeposit = jobs.reduce(
			(current, next) => current + next.dataValues.price,
			0
		);

		if (amount > biggestAmountToDeposit)
			return res.json({ error: 'limit of deposit exceeded' });

		profile.balance += amount;
		await profile.save();
		return res.status(200).send();
	} catch (error) {}
});

app.post('/admin/best-profession', async (req, res) => {
	let startDate =
		req?.query?.start && new Date(req.query.start).toISOString();
	let endDate = req?.query?.end && new Date(req.query.end).toISOString();

	if (
		(startDate && !endDate) ||
		(!startDate && endDate) ||
		startDate.toString() == 'Invalid Date' ||
		endDate.toString() == 'Invalid Date'
	)
		return res.json({ error: 'need both dates to make a range' });

	let queryDate = '';
	if (startDate && endDate) {
		startDate = startDate.split('T').shift();
		endDate = endDate.split('T').shift();
		queryDate = `AND j.paymentDate BETWEEN '${startDate}' AND '${endDate}'`;
	}

	const results = await sequelize.query(`
		SELECT p.profession 
		FROM \`Contracts\` as c 
		JOIN \`Jobs\` as j
		ON c.id = j.ContractId
		JOIN \`Profiles\` as p
		ON c.ContractorId = p.id
		AND j.paid = 1
		${queryDate}
		GROUP BY c.ClientId
		ORDER BY paid DESC
		LIMIT 1
	`);

	res.json(results[0]);
});

app.post('/admin/best-clients', async (req, res) => {
	const limit = req.query.limit || 2;
	let startDate =
		req?.query?.start && new Date(req.query.start).toISOString();
	let endDate = req?.query?.end && new Date(req.query.end).toISOString();

	if (
		(startDate && !endDate) ||
		(!startDate && endDate) ||
		startDate.toString() == 'Invalid Date' ||
		endDate.toString() == 'Invalid Date'
	)
		return res.json({ error: 'need both dates to make a range' });

	let queryDate = '';
	if (startDate && endDate) {
		startDate = startDate.split('T').shift();
		endDate = endDate.split('T').shift();
		queryDate = `AND j.paymentDate BETWEEN '${startDate}' AND '${endDate}'`;
	}

	const results = await sequelize.query(`
		SELECT c.ClientId AS id, SUM(j.price) AS paid,
			p.firstName || ' ' || p.lastName AS fullName
		FROM \`Contracts\` as c 
		JOIN \`Jobs\` as j
		ON c.id = j.ContractId
		JOIN \`Profiles\` as p
		ON c.ClientId = p.id
		AND j.paid = 1
		${queryDate}
		GROUP BY c.ClientId
		ORDER BY paid DESC
		LIMIT ${limit}
	`);

	res.json(results[0]);
});

module.exports = app;
